import type { BrowserWindow } from 'electron'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { AgentQuestionRequest, AgentIntervention } from '../../shared/runtime'
import { appendCoalescedTrace, consumeTraceMutations, stampProjection, traceMutationState, type TraceMutationState } from '../live-trace'
import { sanitizeToolEvent, sanitizeToolEvents, toolContentTurnBudget } from '../../core/turn-recorder/tool-content'
import { UserQuestionBroker, type UserQuestionChange } from '../user-question'
import { RunRegistry } from '../run-registry'
import { RunStopLifecycle } from '../run-stop-lifecycle'
import { TraceOutputBridge } from '../trace-output'
import { RunTraceRouter } from '../run-trace-router'
import { RUN_TRACE_CHANNEL } from '../../shared/run-traces'
import type { DockBadgeState } from '../dock-badge'
import type { RunControl } from './run-control'

interface ProjectionCacheEntry {
  state: TraceMutationState
  /** Opaque token for this entry's projection generation; survives rebuilds, not eviction. */
  generation: object
  items: TraceEvent[]
  /** Turn budget left after each projected item, so a rebuild can resume at any index. */
  remaining: number[]
  seenRevision: number
}

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
  // 多视图 live 流的 run 级路由：每个可见 run 一条自有有界流，不影响焦点与 legacy 焦点通道。
  const runTraces = new RunTraceRouter({
    runs,
    boundedLiveRun: (run) => boundedLiveRun(run),
    onDemandChange: (runId, demanded) => runs.get(runId)?.control.setDiffPreviewDemand?.(demanded),
    canSend: rendererCanReceive,
    send: (event) => { getWindow()?.webContents.send(RUN_TRACE_CHANNEL, event) },
    warn: (message, detail) => console.warn(`[scry] ${message}:`, detail)
  })

  // 停止是一个生命周期而不是一次调用：它把真实进度（已请求/已强杀/未确认终止）发给 renderer，
  // 并把同一份快照挂在 ActiveRun 上，让重挂的 renderer 也能拿到诚实状态。
  const runStopLifecycle = new RunStopLifecycle({
    publish: (state) => {
      const run = runs.get(state.runId)?.state
      if (run) run.stopState = state
      // 停止进度只属于拥有这个 run 的视图：legacy 广播留在原处，scoped 视图另走自己的订阅。
      runTraces.publishStopState(state)
      if (!rendererCanReceive()) return
      flushTraceSend()
      getWindow()?.webContents.send('agent:stopState', state)
    },
    warn: (message, runId, error) => console.warn(`[scry] ${message}:`, runId, error)
  })
  /**
   * Bounded, truthful attention summary: how many questions are pending and how many of
   * them are permission decisions. The renderer needs that to tell "needs approval" from
   * "needs an answer" for runs it does not subscribe to, without a trace subscription.
   */
  function attentionSummary(runId: string, opened?: AgentQuestionRequest): {
    runId: string; pendingCount: number; permissionCount: number; inputCount: number
  } {
    const run = runs.get(runId)?.state
    // An unknown run keeps the fact that a question was just opened; it never invents a
    // kind it was not told about.
    const pending = run ? run.pendingQuestions ?? [] : opened ? [opened] : []
    const permissionCount = pending.filter((item) => item.questionKind === 'permission').length
    return { runId, pendingCount: pending.length, permissionCount, inputCount: pending.length - permissionCount }
  }
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
    getWindow()?.webContents.send('agent:questionAttention', attentionSummary(request.runId, request))
    if (runs.isFocused(request.runId)) getWindow()?.webContents.send('agent:userQuestion', request)
    // 子会话的提问只走它自己的订阅：legacy 通道会被 useAgentSession 在空焦点时认领。
    runTraces.publishQuestion(request)
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
        publishTrace(event)
      }
      // 问题已经结束（已答/取消）：这个会话不再等用户，未读角标不能继续挂着。
      dockBadge.releaseQuestionAttention(activeRunSessionKey(run), run.pendingQuestions?.length ?? 0)
    }
    getWindow()?.webContents.send('agent:questionAttention', attentionSummary(runId))
    if (runs.isFocused(runId)) {
      getWindow()?.webContents.send('agent:userQuestionClosed', { kind: 'closed', runId, questionId, ...(intervention ? { intervention } : {}) })
    }
    runTraces.publishQuestionClosed(runId, questionId)
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
  /**
   * 一条事件的两种交付。legacy 通道仍按焦点投递（含 done=true 之后的 isViewed），
   * scoped 通道把同一事件交给拥有该 run 的视图；没有人订阅时直接丢弃，不缓冲。
   */
  function publishTrace(ev: TraceEvent): void {
    runTraces.route(ev)
    if (runs.isViewed(ev.runId)) queueTrace(ev)
  }

  const LIVE_TOOL_CONTENT_POLICY = {
    toolOutput: 'full' as const,
    toolContentFieldBytes: 8 * 1024,
    toolContentTurnBytes: 128 * 1024
  }

  // Bounded-live projection cache: one projected item list per live run plus the turn budget
  // left after each item, so a read rebuilds only the suffix a recorded write can still affect.
  // Metadata is never cached; it is read from the run on every call.
  //
  // Bounds are the cache's own: eight runs and 50_000 projected items in total, evicted LRU. A
  // run past 50_000 items is projected per read and keeps nothing, so one huge run cannot pin
  // the others. These numbers are not the remote delta bounds in remote/desktop-trace-delta.ts
  // (MAX_RUNS, MAX_REVISIONS, MAX_TRACKED_CHANGES), which this code does not touch.
  //
  // Invalidation basis: the writers mark the earliest dirty index on the raw array
  // (main/live-trace.ts) and the array identity is the generation. The policy and source are
  // fixed privates, so changing them is a code change that must drop the whole cache.
  const MAX_CACHED_RUNS = 8
  const MAX_CACHED_ITEMS = 50_000
  const PROJECTION_SOURCE = 'live_renderer'
  const projections = new Map<string, ProjectionCacheEntry>()
  let projectedItems = 0
  function forgetBoundedRun(runId: string): void {
    const entry = projections.get(runId)
    if (!entry) return
    projectedItems -= entry.items.length
    projections.delete(runId)
  }
  function projectRun(run: ActiveRun): TraceEvent[] {
    const state = traceMutationState(run.items)
    // No writer ever recorded anything on this array, so nothing is known about it and nothing
    // may be cached: project it in full through the unchanged array path.
    // A run past the cache bound is treated the same way, and its state is neither created nor
    // consumed, so a huge run cannot pin or pollute the cache either.
    if (!state || run.items.length > MAX_CACHED_ITEMS) {
      forgetBoundedRun(run.runId)
      return sanitizeToolEvents(run.items, LIVE_TOOL_CONTENT_POLICY, PROJECTION_SOURCE)
    }
    // A different array is a different generation: its indices and its content both restart.
    if (projections.get(run.runId)?.state !== state) forgetBoundedRun(run.runId)
    const cached = projections.get(run.runId)
    // Nothing was written and nothing is pending: reuse the cached projection itself, only
    // touching its LRU position. Metadata is spread fresh by the caller.
    if (cached && cached.seenRevision === state.revision && cached.items.length === run.items.length) {
      projections.delete(run.runId)
      projections.set(run.runId, cached)
      return cached.items
    }
    // Another reader may already have consumed the dirty range this entry still owes; then only
    // a full rebuild is honest. Otherwise resume at the earliest recorded write.
    const from = !cached ? 0
      : cached.seenRevision >= state.baseRevision ? Math.min(state.dirtyFrom, run.items.length) : 0
    const generation = cached?.generation ?? {}
    const items = cached ? cached.items.slice(0, from) : []
    const remaining = cached ? cached.remaining.slice(0, from) : []
    let budget = from === 0 ? toolContentTurnBudget(LIVE_TOOL_CONTENT_POLICY) : cached!.remaining[from - 1]
    for (let index = from; index < run.items.length; index++) {
      const step = sanitizeToolEvent(run.items[index], LIVE_TOOL_CONTENT_POLICY, PROJECTION_SOURCE, budget)
      // Non-tool events come back as the raw object, and the cache owns its projection: keep a
      // top-level snapshot so a later in-place correction cannot rewrite what a reader has.
      items.push(step.event === run.items[index] ? { ...step.event } : step.event)
      remaining.push(step.remaining)
      budget = step.remaining
    }
    // Snapshot the numbers before consuming: they describe the array just built, and the stamp
    // must not alias the mutable mutation state afterwards.
    stampProjection(items, {
      generation,
      revision: state.revision,
      baseRevision: cached?.seenRevision ?? null,
      dirtyFrom: from
    })
    consumeTraceMutations(run.items)
    projectedItems -= cached?.items.length ?? 0
    projections.delete(run.runId)
    projections.set(run.runId, { state, generation, items, remaining, seenRevision: state.revision })
    projectedItems += items.length
    while (projections.size > MAX_CACHED_RUNS || projectedItems > MAX_CACHED_ITEMS) {
      const oldest = projections.keys().next().value
      if (oldest === undefined) break
      forgetBoundedRun(oldest)
    }
    return items
  }

  function boundedLiveRun(run: ActiveRun): ActiveRun {
    return { ...run, items: projectRun(run) }
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
    userQuestionBroker, traceOutput, flushTraceSend, queueTrace, publishTrace, boundedLiveRun, forgetBoundedRun,
    requestRunStop, LIVE_TOOL_CONTENT_POLICY, runTraces
  }
}
