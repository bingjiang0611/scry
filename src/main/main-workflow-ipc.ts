import type { RemoteRunCompletion } from './remote/remote-run-binding'
import type { ActiveRun } from '../shared/trace'
import type { RunControl } from './app-run-lifecycle-types'
import { RunRegistry } from './run-registry'
import { RunStopLifecycle } from './run-stop-lifecycle'
import { createMainRunObservation } from './main-run-observation'
import type { RemoteHostService } from './remote/remote-host-service'
import { CommandReceipts } from './command-receipts'
import { createAppWorkflowRuntime } from './workflow-app-runtime'
import { createTypeSafeWorkflowClassifierAdapter } from './typesafe-workflow-classifier'
import { WorkflowTemplateEditCandidateStore } from './workflow-template-edit-candidate-store'
import { createDesktopTemplateEditAuthoring } from './desktop-template-edit-authoring'
import { WorkflowTemplateEditApplicationStore } from './workflow-template-edit-application-store'
import { createDesktopTemplateEditCandidateApplication } from './desktop-template-edit-candidate-application'
import { createDesktopWorkflowTaskEntry } from './desktop-workflow-task-entry'
import type { createDesktopTaskEntry } from './desktop-task-entry'
import { registerWorkflowIpc } from './workflow-ipc'
import { registerWorkflowTemplateIpc, registerWorkflowTemplateInstantiationIpc } from './workflow-template-ipc'
import { registerRunIpc } from './run-ipc'
import { registerAnalyticsIpc } from './analytics-ipc'
import { registerGitDiffIpc } from './git'
import { registerRecorderContentIpc } from './recorder-content-ipc'
import type { ProviderContext } from '../shared/provider'
import { workflowAuthoringCopy, workflowTemplateCopy } from '../shared/constants/copy'
import { canonicalExistingDirectoryAsync } from './workspace-authorization'
import type { MainTrustedIpcHandler } from './main-session-ipc'

export type MainWorkflowRuntime = ReturnType<typeof createAppWorkflowRuntime>

type WorkflowRuntime = Parameters<typeof createAppWorkflowRuntime>[0]
type RunIpc = Parameters<typeof registerRunIpc>[0]
type AnalyticsIpc = Parameters<typeof registerAnalyticsIpc>[0]
type RecorderContentIpc = Parameters<typeof registerRecorderContentIpc>[0]

type StopRequest = Parameters<RunStopLifecycle['request']>[0]

export function createMainRunRuntime(deps: {
  dockBadge: Parameters<typeof createMainRunObservation>[0]['dockBadge']
  getWindow: Parameters<typeof createMainRunObservation>[0]['getWindow']
  rendererCanReceive: Parameters<typeof createMainRunObservation>[0]['rendererCanReceive']
  mainEventId: Parameters<typeof createMainRunObservation>[0]['mainEventId']
  activeRunSessionKey: Parameters<typeof createMainRunObservation>[0]['activeRunSessionKey']
  appendTrace: Parameters<typeof createMainRunObservation>[0]['appendTrace']
}): {
  runs: RunRegistry<ActiveRun, RunControl>
  runStopLifecycle: RunStopLifecycle
  userQuestionBroker: ReturnType<typeof createMainRunObservation>['userQuestionBroker']
  traceOutput: ReturnType<typeof createMainRunObservation>['traceOutput']
  publishQuestionOpened: ReturnType<typeof createMainRunObservation>['publishQuestionOpened']
  publishQuestionClosed: ReturnType<typeof createMainRunObservation>['publishQuestionClosed']
  flushTraceSend: ReturnType<typeof createMainRunObservation>['flushTraceSend']
  queueTrace: ReturnType<typeof createMainRunObservation>['queueTrace']
  boundedLiveRun: ReturnType<typeof createMainRunObservation>['boundedLiveRun']
} {
  const runs = new RunRegistry<ActiveRun, RunControl>()
  let flushTraceSend = (): void => {}
  const runStopLifecycle = new RunStopLifecycle({
    publish: state => {
      const run = runs.get(state.runId)?.state
      if (run) run.stopState = state
      if (!deps.rendererCanReceive()) return
      flushTraceSend()
      deps.getWindow()?.webContents.send('agent:stopState', state)
    },
    warn: (message, runId, error) => console.warn(`[scry] ${message}:`, runId, error)
  })
  const observation = createMainRunObservation({ runs, dockBadge: deps.dockBadge, getWindow: deps.getWindow, rendererCanReceive: deps.rendererCanReceive, mainEventId: deps.mainEventId, activeRunSessionKey: deps.activeRunSessionKey, appendTrace: deps.appendTrace })
  flushTraceSend = observation.flushTraceSend
  return { runs, runStopLifecycle, ...observation }
}

export function createMainRunStopControls(deps: {
  runs: { get: (runId: string) => { state: { done: boolean }; control: StopRequest } | undefined }
  runStopLifecycle: Pick<RunStopLifecycle, 'request' | 'repeat'>
  cancelQuestions: (runId: string) => void
}): { requestRunStop: (runId: string) => boolean; requestRunStopAgain: (runId: string) => boolean } {
  const requestRunStop = (runId: string): boolean => {
    const entry = deps.runs.get(runId)
    if (!entry || entry.state.done) return false
    deps.runStopLifecycle.request(entry.control)
    deps.cancelQuestions(runId)
    return true
  }
  const requestRunStopAgain = (runId: string): boolean => {
    const entry = deps.runs.get(runId)
    if (!entry || entry.state.done) return false
    deps.cancelQuestions(runId)
    return Boolean(deps.runStopLifecycle.repeat(entry.control))
  }
  return { requestRunStop, requestRunStopAgain }
}

export interface MainWorkflowIpcDeps {
  handleTrusted: MainTrustedIpcHandler
  userData: string
  providerRegistry: WorkflowRuntime['providerRegistry']
  providerContextKey: WorkflowRuntime['providerContextKey']
  withProviderOperation: WorkflowRuntime['withProviderOperation']
  startAppRun: WorkflowRuntime['startAppRun']
  requestRunStop: WorkflowRuntime['requestRunStop']
  requestRunStopAgain: WorkflowRuntime['requestRunStopAgain']
  resolveTemplateProjectDirectory: (cwd: string) => Promise<string>
  rendererCanReceive: () => boolean
  sendProgress: (progress: Parameters<NonNullable<WorkflowRuntime['onProgress']>>[0]) => void
  currentCwd: () => string | undefined
  canonicalExistingDirectory: (cwd: string) => string
  run: Omit<RunIpc, 'handleTrusted' | 'startAppRun' | 'remoteRunLedgerId' | 'answerRemoteQuestion'>
  remoteRunLedgerIds: Map<string, string>
  remoteHost: () => RemoteHostService | null
  providerContinuationKey: (context: ProviderContext) => Promise<string>
  conversationStore: Parameters<typeof createDesktopTemplateEditAuthoring>[0]['conversations']
  desktopTaskEntry: ReturnType<typeof createDesktopTaskEntry>
  userDataDir: () => string
  resolveKnownProjectDirectory: (cwd: string) => string
  recorder: Omit<RecorderContentIpc, 'handleTrusted' | 'currentCwd' | 'userDataDir'>
  analytics: Omit<AnalyticsIpc, 'handleTrusted' | 'userDataDir' | 'activeRuns'>
}

export interface MainWorkflowIpcResult extends MainWorkflowRuntime {
  remoteStartReceipts: CommandReceipts<RemoteRunCompletion>
  desktopWorkflowTasks: ReturnType<typeof createDesktopWorkflowTaskEntry>
}

export function registerMainWorkflowIpc(deps: MainWorkflowIpcDeps): MainWorkflowIpcResult {
  const workflowRuntime = createAppWorkflowRuntime({
    userData: deps.userData,
    providerRegistry: deps.providerRegistry,
    providerContextKey: deps.providerContextKey,
    withProviderOperation: deps.withProviderOperation,
    startAppRun: deps.startAppRun,
    requestRunStop: deps.requestRunStop,
    requestRunStopAgain: deps.requestRunStopAgain,
    resolveTemplateProjectDirectory: deps.resolveTemplateProjectDirectory,
    onProgress: progress => deps.sendProgress(progress),
    classifierAdapter: createTypeSafeWorkflowClassifierAdapter(process.env.TYPESAFE_API_KEY)
  })
  const { workflowService, workflowStore, workflowTemplates, workflowSourceApplications, workflowRunControls, runAuthoring } = workflowRuntime
  const resolveWorkflowAuthoringContinuationKey = (context: ProviderContext) => {
    if (!deps.providerRegistry.get(context.providerId).workflowAuthoring) throw new Error(workflowAuthoringCopy.unavailable)
    return deps.withProviderOperation(context.providerId, () => deps.providerContinuationKey(context), context.agentProfileId)
  }
  const templateEditCandidates = new WorkflowTemplateEditCandidateStore(deps.userData)
  const templateEditApplications = new WorkflowTemplateEditApplicationStore(deps.userData)
  const desktopTemplateEditAuthoring = createDesktopTemplateEditAuthoring({
    conversations: deps.conversationStore,
    templates: () => workflowTemplates,
    candidates: templateEditCandidates,
    resolveWorkspace: deps.resolveTemplateProjectDirectory,
    resolveContinuationKey: resolveWorkflowAuthoringContinuationKey,
    providerAuthoringAvailable: providerId => Boolean(deps.providerRegistry.get(providerId).workflowAuthoring),
    workflowRunControls,
    runAuthoring
  })
  const desktopTemplateEditApplication = createDesktopTemplateEditCandidateApplication({
    conversations: deps.conversationStore,
    templates: () => workflowTemplates,
    candidates: templateEditCandidates,
    applications: templateEditApplications,
    resolveWorkspace: deps.resolveTemplateProjectDirectory
  })
  const desktopWorkflowTasks = createDesktopWorkflowTaskEntry({
    conversations: deps.conversationStore,
    workflows: workflowStore,
    service: workflowService,
    templates: () => workflowTemplates,
    candidates: templateEditCandidates,
    applications: templateEditApplications,
    intake: deps.desktopTaskEntry,
    ownerEpoch: deps.desktopTaskEntry.ownerEpoch,
    resolveWorkspace: deps.resolveTemplateProjectDirectory,
    resolveContinuationKey: resolveWorkflowAuthoringContinuationKey
  })
  const registerWorkflow = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    deps.handleTrusted(channel, (_event, ...args: unknown[]) => listener(...args))
  }
  registerWorkflowIpc({
    capturedTasks: desktopWorkflowTasks,
    templateEditAuthoring: desktopTemplateEditAuthoring,
    templateEditApplication: desktopTemplateEditApplication,
    sourceApplications: workflowSourceApplications,
    register: registerWorkflow,
    service: workflowService,
    resolveWorkspace: deps.resolveKnownProjectDirectory,
    assertCurrentWorkspace: workspace => {
      if (deps.currentCwd() && workspace !== deps.canonicalExistingDirectory(deps.currentCwd()!)) throw new Error(workflowTemplateCopy.workspace)
    }
  })
  registerWorkflowTemplateIpc(registerWorkflow, workflowTemplates)
  registerWorkflowTemplateInstantiationIpc(registerWorkflow, workflowService, async cwd => {
    const workspace = await deps.resolveTemplateProjectDirectory(cwd)
    if (deps.currentCwd() && workspace !== await canonicalExistingDirectoryAsync(deps.currentCwd()!)) throw new Error(workflowTemplateCopy.workspace)
    return workspace
  })

  const remoteStartReceipts = new CommandReceipts<RemoteRunCompletion>()
  registerRunIpc({
    handleTrusted: deps.handleTrusted,
    startAppRun: deps.startAppRun,
    ...deps.run,
    remoteRunLedgerId: runId => deps.remoteRunLedgerIds.get(runId),
    answerRemoteQuestion: (ledgerRunId, response) => deps.remoteHost()?.controller.answerOwnerQuestion(ledgerRunId, response) ?? false
  })
  registerAnalyticsIpc({ ...deps.analytics, handleTrusted: deps.handleTrusted, userDataDir: deps.userDataDir, activeRuns: () => deps.run.runs.activeStates() })
  registerGitDiffIpc(deps.handleTrusted, deps.resolveKnownProjectDirectory)
  registerRecorderContentIpc({ ...deps.recorder, handleTrusted: deps.handleTrusted, currentCwd: deps.currentCwd, userDataDir: deps.userDataDir })
  return { ...workflowRuntime, remoteStartReceipts, desktopWorkflowTasks }
}
