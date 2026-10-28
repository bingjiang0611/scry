import type { IpcMainInvokeEvent } from 'electron'
import type { AgentQuestionResponse, AgentStartRequest, AgentSteerInput, AgentSteerResult } from '../shared/runtime'
import type { ActiveRun } from '../shared/trace'
import type { BackgroundTaskStopResult } from '../shared/background-work'
import type { DockBadgeState } from './dock-badge'
import { CommandReceipts } from './command-receipts'
import { stopObservedBackgroundTask } from './background-task-control'
import { steerObservedRun } from './run-steering'
import type { UserQuestionBroker } from './user-question'
import type { TraceBatchReceipt, TraceOutputBridge } from './trace-output'
import type { RemoteRunCompletion } from './remote/remote-run-binding'

interface ObservedRunEntry {
  state: ActiveRun
  control: {
    adoptSession: () => void
    stopBackgroundTask: (taskId: string) => Promise<BackgroundTaskStopResult>
    steer: (input: AgentSteerInput) => Promise<AgentSteerResult>
  }
}

/** Run start, live observation, question routing, and run controls only. Trusted IPC remains registered by the main-owned wrapper. */
export function registerRunIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  startAppRun: (payload: AgentStartRequest) => Promise<{ runId: string } | RemoteRunCompletion>
  runs: {
    focusedState: () => ActiveRun | null
    focusedSnapshot: () => ActiveRun | null
    activeStates: () => ActiveRun[]
    focus: (runId: string | null) => boolean
    get: (runId: string) => ObservedRunEntry | undefined
  }
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  activeRunSessionKey: (run: ActiveRun) => string | null
  dockBadge: Pick<DockBadgeState, 'snapshot' | 'view'>
  window: () => { isFocused: () => boolean; webContents: { id: number } } | null
  userQuestionBroker: Pick<UserQuestionBroker, 'answer'>
  remoteRunLedgerId: (runId: string) => string | undefined
  answerRemoteQuestion: (ledgerRunId: string, response: AgentQuestionResponse) => boolean
  traceOutput: Pick<TraceOutputBridge, 'ack' | 'resynchronized'>
  requestRunStop: (runId: string) => boolean
}) {
  const agentStartReceipts = new CommandReceipts<{ runId: string } | RemoteRunCompletion>()

  deps.handleTrusted('agent:start', async (_event, payload: AgentStartRequest) => {
    const receipt = await agentStartReceipts.submit(payload?.commandId?.trim() || undefined, () => deps.startAppRun(payload))
    return { ...receipt.result, commandStatus: receipt.status, commandSequence: receipt.sequence }
  })

  // Renderer 重挂时拉回当前焦点或全部在途 run；焦点只影响显示，不影响后台生命周期。
  deps.handleTrusted('agent:activeRun', (): ActiveRun | null => {
    const state = deps.runs.focusedState()
    return state ? deps.boundedLiveRun(state) : null
  })
  deps.handleTrusted('agent:unreadSessions', () => deps.dockBadge.snapshot())
  // live trace 降级恢复专用：忽略 done，只要 registry 里还有这个 run 就给出权威事件序列。
  // activeRun 会因为 done=true 返回 null，那样终态被跳过的事件永远补不回来。
  deps.handleTrusted('agent:focusedRunSnapshot', (): ActiveRun | null => {
    const state = deps.runs.focusedSnapshot()
    return state ? deps.boundedLiveRun(state) : null
  })
  deps.handleTrusted('agent:activeRuns', (): ActiveRun[] => deps.runs.activeStates().map(deps.boundedLiveRun))
  deps.handleTrusted('agent:focusRun', (_event, runId: string | null): boolean => {
    const focused = deps.runs.focus(runId)
    if (!focused || !runId) return focused
    const sessionKey = deps.activeRunSessionKey(deps.runs.get(runId)!.state)
    if (sessionKey) deps.dockBadge.view(sessionKey, Boolean(deps.window()?.isFocused()))
    return true
  })
  deps.handleTrusted('agent:adoptActiveRun', (_event, runId: string): ActiveRun | null => {
    const entry = deps.runs.get(runId)
    if (!entry || entry.state.done) return null
    entry.control.adoptSession()
    deps.runs.focus(runId)
    const sessionKey = deps.activeRunSessionKey(entry.state)
    if (sessionKey) deps.dockBadge.view(sessionKey, Boolean(deps.window()?.isFocused()))
    return deps.boundedLiveRun(entry.state)
  })
  deps.handleTrusted('agent:answerQuestion', (event, response: unknown) => {
    const window = deps.window()
    if (!window || event.sender.id !== window.webContents.id) return false
    const runId = (response as { runId?: unknown } | null)?.runId
    const ledgerRunId = typeof runId === 'string' ? deps.remoteRunLedgerId(runId) : undefined
    // A device-started run's question lives on the remote broker; answering it
    // here settles the same question the device sees, exactly once.
    if (ledgerRunId) return deps.answerRemoteQuestion(ledgerRunId, response as AgentQuestionResponse)
    return deps.userQuestionBroker.answer(response)
  })

  deps.handleTrusted('agent:traceAck', (_event, request: TraceBatchReceipt) => deps.traceOutput.ack(request))
  // renderer 已经用权威快照（activeRun）对齐 live 视图，降级标记可以清除。
  deps.handleTrusted('agent:traceResynchronized', () => {
    deps.traceOutput.resynchronized()
    return true as const
  })

  deps.handleTrusted('agent:stopBackgroundTask', (_event, payload: unknown) =>
    stopObservedBackgroundTask(payload, (runId) => deps.runs.get(runId)))
  deps.handleTrusted('agent:stop', (_event, runId: string) => deps.requestRunStop(runId))
  deps.handleTrusted('agent:steer', (_event, payload: unknown) =>
    steerObservedRun(payload, (runId) => deps.runs.get(runId)))
}
