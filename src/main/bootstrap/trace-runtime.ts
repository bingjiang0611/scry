import type { BrowserWindow } from 'electron'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { AgentQuestionRequest, AgentIntervention } from '../../shared/runtime'
import { appendCoalescedTrace } from '../live-trace'
import { sanitizeToolEvents } from '../../core/turn-recorder/tool-content'
import { UserQuestionBroker, type UserQuestionChange } from '../user-question'
import { RunRegistry } from '../run-registry'
import { RunStopLifecycle } from '../run-stop-lifecycle'
import { TraceOutputBridge } from '../trace-output'
import type { DockBadgeState } from '../dock-badge'
import type { RunControl } from './run-control'

export function createTraceRuntime({
  getWindow, rendererCanReceive, activeRunSessionKey, dockBadge, mainEventId
}: {
  getWindow: () => BrowserWindow | null
  rendererCanReceive: () => boolean
  activeRunSessionKey: (run: ActiveRun) => string | null
  dockBadge: DockBadgeState
  mainEventId: (prefix: string, runId: string) => string
}) {
  // 每个 run 独立持有 Provider handle、问题与 diff 生命周期；focused 只表示当前 UI 正在看谁。
  const runs = new RunRegistry<ActiveRun, RunControl>()
  // 停止是一个生命周期而不是一次调用：它把真实进度（已请求/已强杀/未确认终止）发给 renderer，
  // 并把同一份快照挂在 ActiveRun 上，让重挂的 renderer 也能拿到诚实状态。
  const runStopLifecycle = new RunStopLifecycle({
    publish: (state) => {
      const run = runs.get(state.runId)?.state
      if (run) run.stopState = state
      if (!rendererCanReceive()) return
      flushTraceSend()
      getWindow()?.webContents.send('agent:stopState', state)
    },
    warn: (message, runId, error) => console.warn(`[scry] ${message}:`, runId, error)
  })
  // One pending-question projection for the run state, dock and renderer. Shared by
  // the Mac broker and device-started runs, whose questions live on the remote
  // broker but are mirrored here so the Mac can answer them too.
  function publishQuestionOpened(request: AgentQuestionRequest): void {
    const run = runs.get(request.runId)?.state
    if (run) {
      run.pendingQuestions = [
        ...(run.pendingQuestions ?? []).filter((item) => item.questionId !== request.questionId),
        request
      ]
      const sessionKey = activeRunSessionKey(run)
      if (sessionKey) dockBadge.markAttention(sessionKey, {
        windowFocused: Boolean(getWindow()?.isFocused()),
        sessionViewed: runs.isViewed(run.runId),
        needsAttention: true
      })
    }
    getWindow()?.webContents.send('agent:questionAttention', {
      runId: request.runId,
      pendingCount: run?.pendingQuestions?.length ?? 1
    })
    if (runs.isFocused(request.runId)) getWindow()?.webContents.send('agent:userQuestion', request)
  }
  // `intervention` is absent for device-started runs: remote-run-binding records
  // their intervention trace event itself.
  function publishQuestionClosed(runId: string, questionId: string, intervention?: AgentIntervention): void {
    const run = runs.get(runId)?.state
    if (run) {
      run.pendingQuestions = (run.pendingQuestions ?? []).filter((item) => item.questionId !== questionId)
      if (intervention) {
        const event: TraceEvent = {
          id: mainEventId('intervention', runId),
          ts: intervention.closedAt,
          runId,
          kind: 'human',
          stage: 'intervention',
          toolUseId: questionId,
          providerId: intervention.request.providerId,
          agentId: intervention.request.agentId,
          durationMs: intervention.durationMs,
          intervention
        }
        appendCoalescedTrace(run.items, event)
        if (runs.isFocused(runId)) queueTrace(event)
      }
    }
    getWindow()?.webContents.send('agent:questionAttention', {
      runId,
      pendingCount: run?.pendingQuestions?.length ?? 0
    })
    if (runs.isFocused(runId)) {
      getWindow()?.webContents.send('agent:userQuestionClosed', { kind: 'closed', runId, questionId, ...(intervention ? { intervention } : {}) })
    }
  }
  const userQuestionBroker = new UserQuestionBroker((change: UserQuestionChange) => {
    if (change.kind === 'open') publishQuestionOpened(change.request)
    else publishQuestionClosed(change.runId, change.questionId, change.intervention)
  })
  // 性能：把 onTrace 逐条 IPC 合批——流式期每 token 一条 IPC（每秒上百）→ 缓冲一批数组发。
  // 保序（FIFO buffer）、不丢（done/error 前 flushTraceSend 强制清空全部）。
  // 有界与背压由 TraceOutputBridge 承担：单批受事件/字节上限约束，在途字节到 high-water
  // 就等 renderer ACK；过载时只停止镜像最新事件并如实上报缺口，权威证据仍在 runState 与归档。
  const traceOutput = new TraceOutputBridge({
    canSend: rendererCanReceive,
    // 贴近一帧合批：仍把高频 token 合成数组，但把首字/工具状态额外等待从 50ms
    // 降到约一帧。renderer 还会在 requestAnimationFrame 内统一提交 React state。
    flushMs: 16,
    send: (payload) => getWindow()?.webContents.send('agent:trace', payload),
    publishHealth: (state) => {
      if (!rendererCanReceive()) return
      getWindow()?.webContents.send('agent:traceHealth', state)
    },
    warn: (message, state) => console.warn(`[scry] ${message}:`, state)
  })
  function flushTraceSend(): void {
    traceOutput.flushAll()
  }
  function queueTrace(ev: TraceEvent): void {
    traceOutput.push(ev)
  }

  const LIVE_TOOL_CONTENT_POLICY = {
    toolOutput: 'full' as const,
    toolContentFieldBytes: 8 * 1024,
    toolContentTurnBytes: 128 * 1024
  }

  function boundedLiveRun(run: ActiveRun): ActiveRun {
    return { ...run, items: sanitizeToolEvents(run.items, LIVE_TOOL_CONTENT_POLICY, 'live_renderer') }
  }

  function requestRunStop(runId: string): boolean {
    const entry = runs.get(runId)
    if (!entry || entry.state.done) return false
    const stopping = entry.control
    // 有界升级取代旧的「2s 后假装这一轮已结束」：先协作取消，窗口到点升级 forceKill，
    // 再到点只诚实报告 Provider 未确认终止。终态仍然只能由真实 settle 产生。
    runStopLifecycle.request({
      runId: stopping.runId,
      providerId: stopping.providerId,
      agentProfileId: stopping.runState.agentProfileId,
      runtimeProvider: stopping.runtimeProvider,
      interrupt: stopping.interrupt,
      forceKill: stopping.forceKill,
      forceKillScope: stopping.forceKillScope
    })
    userQuestionBroker.cancelRun(stopping.runId)
    return true
  }

  return {
    runs, runStopLifecycle, publishQuestionOpened, publishQuestionClosed,
    userQuestionBroker, traceOutput, flushTraceSend, queueTrace, boundedLiveRun,
    requestRunStop, LIVE_TOOL_CONTENT_POLICY
  }
}
