import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import { isCommandId, type AgentQuestionResponse, type AgentStartRequest } from '../../shared/runtime'
import type { RunRegistry } from '../run-registry'
import type { RunTraceRouter } from '../run-trace-router'
import { unreadSessionsAnswerWhenKnown, type DockBadgeState } from '../dock-badge'
import type { TraceBatchReceipt } from '../trace-output'
import { registerRunTraceHandlers } from './run-trace-ipc'
import { installRecorderContentWindowCwd } from './recorder-content-daemon'
import type { DaemonRunSurface } from './daemon-run-surface'
import type { RunControl } from './run-control'

export type TrustedRegistrar = <Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
) => void

/**
 * The run channels of this window. The daemon owns every run the window shows, so each
 * answers from the daemon's frames through the daemon run surface; the App keeps only the
 * view state (focus, the dock badge, the live trace streams it delivers).
 */
export function registerAgentRuntimeHandlers({
  handleTrusted, runs, dockBadge, activeRunSessionKey, getWindow, getCurrentCwd, runTraces, daemon
}: {
  handleTrusted: TrustedRegistrar
  /** The window's run registry: the trace router's own runs (daemon runs attach to the router). */
  runs: Pick<RunRegistry<ActiveRun, RunControl>, 'isViewed'>
  dockBadge: DockBadgeState
  activeRunSessionKey: (run: ActiveRun) => string | null
  getWindow: () => BrowserWindow | null
  getCurrentCwd: () => string | undefined
  runTraces: RunTraceRouter
  daemon: DaemonRunSurface
}): void {
  handleTrusted('agent:start', async (_e, payload: AgentStartRequest) => {
    const commandId = payload?.commandId?.trim()
    if (commandId && !isCommandId(commandId)) {
      throw new Error('commandId 必须是 8-128 个字符的 [A-Za-z0-9_:-]')
    }
    return await daemon.start(payload)
  })

  // Renderer 重挂时拉回当前焦点或全部在途 run；焦点只影响显示，不影响后台生命周期。
  handleTrusted('agent:activeRun', async (): Promise<ActiveRun | null> => await daemon.activeRun())
  // D1: the queue is the host's, so the App asks for it instead of reconstructing one from what it
  // sent. The App knows a session by its own id, provider and cwd; the daemon resolves the key.
  handleTrusted('agent:hostQueue', async (_e, request: unknown) => {
    return await daemon.localOp({ op: 'hostQueue', method: 'hostQueue', args: [hostQueueRequest(request)], read: true })
  })
  // D5: rolling back rewrites the run's worktree, so the run id is validated here and the decision
  // about which worktrees may be reset stays with the host's checkpoint service.
  handleTrusted('agent:rollbackRun', async (_e, request: unknown) => {
    const value = (request ?? {}) as { runId?: unknown; reason?: unknown }
    if (typeof value.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId)) throw new Error('invalid_run_id')
    if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 512)) throw new Error('invalid_reason')
    const args = [{ runId: value.runId, ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {}) }]
    return await daemon.localOp({ op: 'checkpoints', method: 'rollbackRun', args, read: false })
  })
  // D1: a held queue entry only moves when the user says so; the run id is the only input.
  handleTrusted('agent:releaseQueuedRun', async (_e, runId: unknown) => {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('invalid_run_id')
    return await daemon.localOp({ op: 'checkpoints', method: 'releaseQueuedRun', args: [{ runId }], read: false })
  })
  // C4: the restart offer is a host fact; the press is a host write that submits one agent turn.
  handleTrusted('agent:restartNote', async (_e, request: unknown) => {
    return await daemon.localOp({ op: 'restartNote', method: 'restartNote', args: [hostQueueRequest(request)], read: true })
  })
  handleTrusted('agent:continueAfterRestart', async (_e, request: unknown) => {
    return await daemon.localOp({ op: 'restartNote', method: 'continueAfterRestart', args: [hostQueueRequest(request)], read: false })
  })
  let detailOwner: IpcMainInvokeEvent['sender'] | undefined
  const clearDetailOwner = () => { detailOwner = undefined; daemon.watchDetail?.(null) }
  handleTrusted('agent:watchSessionDetail', (event, key: unknown): boolean => {
    if (key !== null && (typeof key !== 'string' || !key || key.length > 4096 || key.includes('\0'))) {
      throw new Error('invalid_session_detail')
    }
    if (event.sender.id !== getWindow()?.webContents.id || !daemon.watchDetail?.(key)) return false
    detailOwner?.removeListener('destroyed', clearDetailOwner)
    detailOwner = key === null ? undefined : event.sender
    detailOwner?.once('destroyed', clearDetailOwner)
    return true
  })
  handleTrusted('agent:unreadSessions', () => unreadSessionsAnswerWhenKnown(dockBadge, true))
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
  // live trace 降级恢复专用：忽略 done，只要 daemon 还登记着这个 run 就给出权威事件序列。
  handleTrusted('agent:focusedRunSnapshot', async (): Promise<ActiveRun | null> => await daemon.focusedRunSnapshot())
  handleTrusted('agent:activeRuns', async (): Promise<ActiveRun[]> => await daemon.activeRuns())
  // Showing a run views its session; that is what clears the daemon's unread entry for it (E1b).
  const viewRunSession = (run: ActiveRun | null): void => {
    const sessionKey = run && activeRunSessionKey(run)
    if (sessionKey) dockBadge.view(sessionKey, Boolean(getWindow()?.isFocused()))
  }
  handleTrusted('agent:focusRun', async (_event, runId: string | null): Promise<boolean> => {
    const focused = await daemon.focusRun(runId)
    if (focused && runId === null) dockBadge.view(null, false)
    else if (focused && runId) viewRunSession(await daemon.focusedRunSnapshot())
    return focused
  })
  handleTrusted('agent:adoptActiveRun', async (_event, runId: string): Promise<ActiveRun | null> => {
    const adopted = await daemon.adopt(runId)
    viewRunSession(adopted)
    return adopted
  })
  handleTrusted('agent:answerQuestion', async (event, response: unknown) => {
    const win = getWindow()
    if (!win || event.sender.id !== win.webContents.id) return false
    return daemon.answerQuestion(response as AgentQuestionResponse)
  })

  // Recorder content for this window's selection is the daemon's local op; the App
  // appends the selection and checks it again after the reply.
  installRecorderContentWindowCwd(getCurrentCwd)

  // trace live 镜像的消费确认：renderer 完成批量 state commit 后归还精确批次额度。
  handleTrusted('agent:traceAck', (_event, request: TraceBatchReceipt) => daemon.ack(request))
  // renderer 已经用权威快照（activeRun）对齐 live 视图，降级标记可以清除。
  handleTrusted('agent:traceResynchronized', () => daemon.resynchronized())

  handleTrusted('agent:stopBackgroundTask', async (_event, payload: unknown) => await daemon.stopBackgroundTask(payload))

  // 多视图 live 流：每个可见 run 一条自有有界流（上限两个），与 legacy 焦点通道分离。
  registerRunTraceHandlers(handleTrusted, runTraces, runId => runs.isViewed(runId))

  handleTrusted('agent:stop', (_event, runId: string) => daemon.stop(runId))
  // The registry that owns the run is in the daemon: consulting the App's own registry
  // would answer "identity changed" about a run it never held.
  handleTrusted('agent:steer', async (_event, payload: unknown) => await daemon.steer(payload))
}

/**
 * D1: the shape main is willing to forward. Anything the daemon would have to guess about is
 * refused here, so a bad request never reaches the projection.
 */
function hostQueueRequest(input: unknown): { sessionId: string; providerId?: string; agentProfileId?: string | null; cwd?: string } {
  const value = (input ?? {}) as Record<string, unknown>
  const text = (raw: unknown, max: number): string | undefined => {
    if (raw === undefined) return undefined
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > max || raw.includes('\0')) throw new Error('invalid_session_id')
    return raw
  }
  const sessionId = text(value.sessionId, 512)
  if (sessionId === undefined) throw new Error('invalid_session_id')
  const providerId = text(value.providerId, 128)
  const cwd = text(value.cwd, 4096)
  const agentProfileId = value.agentProfileId === null ? null : text(value.agentProfileId, 128)
  return {
    sessionId,
    ...(providerId === undefined ? {} : { providerId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(agentProfileId === undefined ? {} : { agentProfileId })
  }
}
