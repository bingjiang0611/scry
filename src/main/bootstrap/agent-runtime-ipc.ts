import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { AgentQuestionResponse, AgentStartRequest, AgentStartResult } from '../../shared/runtime'
import { billingStateQuery, importBillingFixture, syncBillingAdmin } from '../db'
import { warmShellEnv } from '../claude-locate'
import { billingChannelHandlers } from './billing-channels'
import { stopObservedBackgroundTask } from '../background-task-control'
import { steerObservedRun } from '../run-steering'
import { CommandReceipts } from '../command-receipts'
import type { RemoteHostService } from '../remote/remote-host-service'
import type { RunRegistry } from '../run-registry'
import type { RunTraceRouter } from '../run-trace-router'
import { unreadSessionsAnswer, type DockBadgeState } from '../dock-badge'
import type { UserQuestionBroker } from '../user-question'
import type { TraceOutputBridge, TraceBatchReceipt } from '../trace-output'
import { registerRunTraceHandlers } from './run-trace-ipc'
import { registerChannelHandlers } from './startup-channels'
import { llmPerformanceChannelHandlers, recorderContentChannelHandlers, usageChannelHandlers, workspaceDiffChannelHandlers } from './query-channels'
import { installRecorderContentWindowCwd } from './recorder-content-daemon'
import type { DaemonRunSurface } from './daemon-run-surface'
import type { RunControl } from './run-control'

export type TrustedRegistrar = <Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
) => void

export function registerAgentRuntimeHandlers({
  handleTrusted, startAppRun, runs, boundedLiveRun, dockBadge, activeRunSessionKey,
  getWindow, getRemoteRunLedgerId, getRemoteHostService, userQuestionBroker,
  resolveKnownProjectDirectory, getCurrentCwd, traceOutput, requestRunStop, runTraces, daemon
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
  runTraces: RunTraceRouter
  /**
   * Daemon mode. When present the daemon owns every run this window shows, so the
   * run channels answer from its frames and never from the in-process registry.
   * Absent (the default) keeps the local pipeline exactly as before.
   */
  daemon?: DaemonRunSurface
}): void {
  // Re-delivery returns the original admission receipt, never starts another logical run.
  const agentStartReceipts = new CommandReceipts<AgentStartResult>()
  handleTrusted('agent:start', async (_e, payload: AgentStartRequest) => {
    const receipt = await agentStartReceipts.submit(
      payload?.commandId?.trim() || undefined,
      () => daemon ? daemon.start(payload) : startAppRun(payload)
    )
    return { ...receipt.result, commandStatus: receipt.status, commandSequence: receipt.sequence }
  })

  // Renderer 重挂时拉回当前焦点或全部在途 run；焦点只影响显示，不影响后台生命周期。
  handleTrusted('agent:activeRun', async (): Promise<ActiveRun | null> => {
    if (daemon) return await daemon.activeRun()
    const state = runs.focusedState()
    return state ? boundedLiveRun(state) : null
  })
  handleTrusted('agent:unreadSessions', () => unreadSessionsAnswer(dockBadge, Boolean(daemon)))
  // A unified conversation shows one native session per Provider binding; none of its
  // runs is the focused run, so the view names them. Keys only: no session is read here.
  handleTrusted('agent:viewSessions', (_event, request: unknown): boolean => {
    const { viewId, main, sessionKeys } = (request ?? {}) as Record<string, unknown>
    if (typeof viewId !== 'string' || viewId.length === 0 || viewId.length > 256 || typeof main !== 'boolean' ||
      !Array.isArray(sessionKeys) || sessionKeys.length > 16 ||
      !sessionKeys.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 4096)) {
      throw new Error('invalid_viewed_sessions')
    }
    dockBadge.viewSessions({ id: viewId, main }, sessionKeys as string[], Boolean(getWindow()?.isFocused()))
    return true
  })
  // live trace 降级恢复专用：忽略 done，只要 registry 里还有这个 run 就给出权威事件序列。
  // activeRun 会因为 done=true 返回 null，那样终态被跳过的事件永远补不回来。
  handleTrusted('agent:focusedRunSnapshot', async (): Promise<ActiveRun | null> => {
    if (daemon) return await daemon.focusedRunSnapshot()
    const state = runs.focusedSnapshot()
    return state ? boundedLiveRun(state) : null
  })
  handleTrusted('agent:activeRuns', async (): Promise<ActiveRun[]> => daemon ? await daemon.activeRuns() : runs.activeStates().map(boundedLiveRun))
  // As in process, showing a run views its session; in daemon mode that is what clears
  // the daemon's unread entry for it (E1b).
  const viewRunSession = (run: ActiveRun | null): void => {
    const sessionKey = run && activeRunSessionKey(run)
    if (sessionKey) dockBadge.view(sessionKey, Boolean(getWindow()?.isFocused()))
  }
  handleTrusted('agent:focusRun', async (_event, runId: string | null): Promise<boolean> => {
    if (daemon) {
      const focused = await daemon.focusRun(runId)
      if (focused && runId) viewRunSession(await daemon.focusedRunSnapshot())
      return focused
    }
    const focused = runs.focus(runId)
    if (!focused || !runId) return focused
    const sessionKey = activeRunSessionKey(runs.get(runId)!.state)
    if (sessionKey) dockBadge.view(sessionKey, Boolean(getWindow()?.isFocused()))
    return true
  })
  handleTrusted('agent:adoptActiveRun', async (_event, runId: string): Promise<ActiveRun | null> => {
    if (daemon) {
      const adopted = await daemon.adopt(runId)
      viewRunSession(adopted)
      return adopted
    }
    const entry = runs.get(runId)
    if (!entry || entry.state.done) return null
    entry.control.adoptSession()
    runs.focus(runId)
    const sessionKey = activeRunSessionKey(entry.state)
    if (sessionKey) dockBadge.view(sessionKey, Boolean(getWindow()?.isFocused()))
    return boundedLiveRun(entry.state)
  })
  handleTrusted('agent:answerQuestion', async (event, response: unknown) => {
    const win = getWindow()
    if (!win || event.sender.id !== win.webContents.id) return false
    const runId = (response as { runId?: unknown } | null)?.runId
    const ledgerRunId = typeof runId === 'string' ? getRemoteRunLedgerId(runId) : undefined
    // A device-started run's question lives on the remote broker; answering it
    // here settles the same question the device sees, exactly once.
    if (ledgerRunId) return getRemoteHostService()?.controller.answerOwnerQuestion(ledgerRunId, response as AgentQuestionResponse) ?? false
    if (daemon) return daemon.answerQuestion(response as AgentQuestionResponse)
    return userQuestionBroker.answer(response)
  })

  // Usage (usage JSONL + SQLite ledger) and LLM performance: the tables the daemon also
  // serves as local ops (query-channels.ts), so both answer from one implementation.
  const userDataDir = (): string => app.getPath('userData')
  registerChannelHandlers(handleTrusted, usageChannelHandlers({ userDataDir }))
  registerChannelHandlers(handleTrusted, llmPerformanceChannelHandlers({ userDataDir, activeRuns: () => runs.activeStates() }))
  // Billing: the table the daemon also serves (billing-channels.ts).
  registerChannelHandlers(handleTrusted, billingChannelHandlers({ warmShellEnv, billingStateQuery, syncBillingAdmin, importBillingFixture }))

  // P2 Files & Diff：cwd 的最终 git diff（vs HEAD 增删），与工具足迹对照
  registerChannelHandlers(handleTrusted, workspaceDiffChannelHandlers(resolveKnownProjectDirectory))
  // Recorder content for this window's selection: the table the daemon also serves; in
  // daemon mode the App appends the selection and checks it again after the reply.
  registerChannelHandlers(handleTrusted, recorderContentChannelHandlers({
    userDataDir,
    workspace: () => getCurrentCwd() ?? '',
    stillCurrent: (cwd) => (getCurrentCwd() ?? '') === cwd
  }))
  if (daemon) installRecorderContentWindowCwd(getCurrentCwd)

  // trace live 镜像的消费确认：renderer 完成批量 state commit 后归还精确批次额度。
  // generation + batchId 防止窗口重挂后的迟到/重复 ACK 释放新 renderer 的额度。
  handleTrusted('agent:traceAck', (_event, request: TraceBatchReceipt) => daemon ? daemon.ack(request) : traceOutput.ack(request))
  // renderer 已经用权威快照（activeRun）对齐 live 视图，降级标记可以清除。
  handleTrusted('agent:traceResynchronized', () => {
    if (daemon) return daemon.resynchronized()
    traceOutput.resynchronized()
    return true as const
  })

  handleTrusted('agent:stopBackgroundTask', async (_event, payload: unknown) =>
    daemon ? await daemon.stopBackgroundTask(payload) : stopObservedBackgroundTask(payload, (runId) => runs.get(runId)))

  // 多视图 live 流：每个可见 run 一条自有有界流（上限两个），与 legacy 焦点通道分离。
  registerRunTraceHandlers(handleTrusted, runTraces, runId => runs.isViewed(runId))

  handleTrusted('agent:stop', (_event, runId: string) => daemon ? daemon.stop(runId) : requestRunStop(runId))
  // In daemon mode the registry that owns the run is in the daemon: consulting the
  // App's own registry would answer "identity changed" about a run it never held.
  handleTrusted('agent:steer', async (_event, payload: unknown) =>
    daemon ? await daemon.steer(payload) : steerObservedRun(payload, (runId) => runs.get(runId)))

}
