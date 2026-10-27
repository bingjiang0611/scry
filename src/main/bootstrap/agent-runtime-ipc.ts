import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ActiveRun, UsageAnalyticsRangeDays } from '../../shared/trace'
import type { AgentQuestionResponse, AgentStartRequest, AgentStartResult } from '../../shared/runtime'
import { summarizeRunningLlmSessions } from '../../shared/llm-performance'
import { billingStateQuery, importBillingFixture, statsQuery, syncBillingAdmin, usageAnalyticsQuery, usageAnalyticsWithCreditsQuery } from '../db'
import { warmShellEnv } from '../claude-locate'
import { readLlmPerformanceHistory } from '../llm-performance-history'
import { stopObservedBackgroundTask } from '../background-task-control'
import { steerObservedRun } from '../run-steering'
import { registerGitDiffIpc } from '../git'
import { readAppTraceContentPage } from '../trace-tool-content'
import { resolveRecorderLocation } from '../../core/turn-recorder/config'
import { readAuthorizedRecorderContentPage } from '../recorder-content-access'
import { CommandReceipts } from '../command-receipts'
import type { RemoteHostService } from '../remote/remote-host-service'
import type { RunRegistry } from '../run-registry'
import type { DockBadgeState } from '../dock-badge'
import type { UserQuestionBroker } from '../user-question'
import type { TraceOutputBridge, TraceBatchReceipt } from '../trace-output'
import type { RunControl } from './run-control'

export type TrustedRegistrar = <Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
) => void

export function registerAgentRuntimeHandlers({
  handleTrusted, startAppRun, runs, boundedLiveRun, dockBadge, activeRunSessionKey,
  getWindow, getRemoteRunLedgerId, getRemoteHostService, userQuestionBroker,
  resolveKnownProjectDirectory, getCurrentCwd, traceOutput, requestRunStop
}: {
  handleTrusted: TrustedRegistrar
  startAppRun: (payload: AgentStartRequest) => Promise<AgentStartResult>
  runs: RunRegistry<ActiveRun, RunControl>
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  dockBadge: DockBadgeState
  activeRunSessionKey: (run: ActiveRun) => string | null
  getWindow: () => BrowserWindow | null
  getRemoteRunLedgerId: (runId: string) => string | undefined
  getRemoteHostService: () => RemoteHostService | null
  userQuestionBroker: UserQuestionBroker
  resolveKnownProjectDirectory: (cwd: string) => string
  getCurrentCwd: () => string | undefined
  traceOutput: TraceOutputBridge
  requestRunStop: (runId: string) => boolean
}): void {
  // Re-delivery returns the original admission receipt, never starts another logical run.
  const agentStartReceipts = new CommandReceipts<AgentStartResult>()
  handleTrusted('agent:start', async (_e, payload: AgentStartRequest) => {
    const receipt = await agentStartReceipts.submit(payload?.commandId?.trim() || undefined, () => startAppRun(payload))
    return { ...receipt.result, commandStatus: receipt.status, commandSequence: receipt.sequence }
  })

  // Renderer 重挂时拉回当前焦点或全部在途 run；焦点只影响显示，不影响后台生命周期。
  handleTrusted('agent:activeRun', (): ActiveRun | null => {
    const state = runs.focusedState()
    return state ? boundedLiveRun(state) : null
  })
  handleTrusted('agent:unreadSessions', () => dockBadge.snapshot())
  // live trace 降级恢复专用：忽略 done，只要 registry 里还有这个 run 就给出权威事件序列。
  // activeRun 会因为 done=true 返回 null，那样终态被跳过的事件永远补不回来。
  handleTrusted('agent:focusedRunSnapshot', (): ActiveRun | null => {
    const state = runs.focusedSnapshot()
    return state ? boundedLiveRun(state) : null
  })
  handleTrusted('agent:activeRuns', (): ActiveRun[] => runs.activeStates().map(boundedLiveRun))
  handleTrusted('agent:focusRun', (_event, runId: string | null): boolean => {
    const focused = runs.focus(runId)
    if (!focused || !runId) return focused
    const sessionKey = activeRunSessionKey(runs.get(runId)!.state)
    if (sessionKey) dockBadge.view(sessionKey, Boolean(getWindow()?.isFocused()))
    return true
  })
  handleTrusted('agent:adoptActiveRun', (_event, runId: string): ActiveRun | null => {
    const entry = runs.get(runId)
    if (!entry || entry.state.done) return null
    entry.control.adoptSession()
    runs.focus(runId)
    const sessionKey = activeRunSessionKey(entry.state)
    if (sessionKey) dockBadge.view(sessionKey, Boolean(getWindow()?.isFocused()))
    return boundedLiveRun(entry.state)
  })
  handleTrusted('agent:answerQuestion', (event, response: unknown) => {
    const win = getWindow()
    if (!win || event.sender.id !== win.webContents.id) return false
    const runId = (response as { runId?: unknown } | null)?.runId
    const ledgerRunId = typeof runId === 'string' ? getRemoteRunLedgerId(runId) : undefined
    // A device-started run's question lives on the remote broker; answering it
    // here settles the same question the device sees, exactly once.
    if (ledgerRunId) return getRemoteHostService()?.controller.answerOwnerQuestion(ledgerRunId, response as AgentQuestionResponse) ?? false
    return userQuestionBroker.answer(response)
  })

  // B2：sqlite 跨会话分析（工具频率 / 按目录花费），纯文件做不到的结构化查询
  handleTrusted('agent:stats', () => statsQuery())
  handleTrusted('agent:llmPerformanceHistory', () => readLlmPerformanceHistory(app.getPath('userData')))
  handleTrusted('agent:llmPerformanceSummary', () => summarizeRunningLlmSessions(runs.activeStates()))

  // 两段返回：SQLite 账本先回到页面（毫秒级），Credit 投影需要读原生 transcript，
  // 单次可达数秒，由 renderer 后取后刷新，不阻塞首屏。
  const usageRange = (rangeDays: unknown): UsageAnalyticsRangeDays => {
    if (rangeDays !== 7 && rangeDays !== 30 && rangeDays !== 90) throw new Error('分析时间范围无效')
    return rangeDays
  }
  handleTrusted('agent:usageAnalytics', (_event, rangeDays: unknown) => usageAnalyticsQuery(usageRange(rangeDays)))
  handleTrusted('agent:usageCredits', (_event, rangeDays: unknown) => usageAnalyticsWithCreditsQuery(usageRange(rangeDays)))
  handleTrusted('agent:billingState', async () => {
    await warmShellEnv()
    return billingStateQuery()
  })
  handleTrusted('agent:syncBillingAdmin', async () => {
    await warmShellEnv()
    return syncBillingAdmin()
  })
  handleTrusted('agent:importBillingFixture', async () => {
    await warmShellEnv()
    return importBillingFixture()
  })

  // P2 Files & Diff：cwd 的最终 git diff（vs HEAD 增删），与工具足迹对照
  registerGitDiffIpc(handleTrusted, resolveKnownProjectDirectory)
  handleTrusted('agent:recorderContentPage', async (_event, request: unknown) => {
    const cwd = getCurrentCwd() ?? ''
    if (request && typeof request === 'object' && 'source' in request) {
      if (request.source !== 'app-trace') throw new Error('invalid_content_source')
      const page = await readAppTraceContentPage(app.getPath('userData'), cwd, request)
      if ((getCurrentCwd() ?? '') !== cwd) throw new Error('recorder_workspace_changed')
      return page
    }
    if (!cwd) throw new Error('recorder_workspace_unavailable')
    // Reading is authorized by the selected workspace's validated recorder location and record
    // references, not by the current enablement flag. Existing evidence remains inspectable when
    // capture is disabled or a sentinel is present; no path supplied by the renderer is opened.
    const location = await resolveRecorderLocation(cwd)
    if (getCurrentCwd() !== cwd) throw new Error('recorder_workspace_changed')
    if (!location.valid) throw new Error(`recorder_unavailable:${location.reason}`)
    return readAuthorizedRecorderContentPage(location.dataRoot, request)
  })

  // trace live 镜像的消费确认：renderer 完成批量 state commit 后归还精确批次额度。
  // generation + batchId 防止窗口重挂后的迟到/重复 ACK 释放新 renderer 的额度。
  handleTrusted('agent:traceAck', (_event, request: TraceBatchReceipt) => traceOutput.ack(request))
  // renderer 已经用权威快照（activeRun）对齐 live 视图，降级标记可以清除。
  handleTrusted('agent:traceResynchronized', () => {
    traceOutput.resynchronized()
    return true as const
  })

  handleTrusted('agent:stopBackgroundTask', (_event, payload: unknown) => stopObservedBackgroundTask(payload, (runId) => runs.get(runId)))

  handleTrusted('agent:stop', (_event, runId: string) => requestRunStop(runId))
  handleTrusted('agent:steer', (_event, payload: unknown) => steerObservedRun(payload, (runId) => runs.get(runId)))

}
