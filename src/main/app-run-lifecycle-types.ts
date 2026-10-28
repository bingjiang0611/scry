import type { BrowserWindow } from 'electron'
import type { AgentForceKillScope, AgentQuestionRequest, AgentStartRequest, AgentSteerInput, AgentSteerResult, RuntimeProvider } from '../shared/runtime'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { ProviderId } from '../shared/provider'
import type { ProviderAdapter, ProviderStructuredOutput } from './providers/types'
import type { AppRunStartOptions } from './app-run-start'
import type { AppRunFrontdoorState } from './app-run-frontdoor'
import type { ManagedConversationStart } from './conversation-service'
import type { PerformanceTrace } from './performance-timing'
import type { LlmNetworkConfigurationCache } from './llm-network-configuration'
import type { BackgroundTaskStopResult } from '../shared/background-work'
import type { ArchiveTraceTurnArgs } from './app-turn-archive'
import type { PreparedAttachment } from './attachment-store'
import type { LiveTraceIngestion } from './live-trace-ingestion'
import type { ProviderRunHandle } from './providers/types'
import type { WorkflowReplicaRun } from './workflow-system-host'

export interface RunControl {
  runId: string
  providerId: ProviderId
  interrupt: () => void
  forceKill: () => void
  stopBackgroundTask: (taskId: string) => Promise<BackgroundTaskStopResult>
  steer: (input: AgentSteerInput) => Promise<AgentSteerResult>
  forceKillScope: () => AgentForceKillScope | undefined
  cwd?: string
  resume?: string
  getExternalSessionId: () => string | undefined
  getProviderTurnId: () => string | undefined
  canonicalLifecycle: boolean
  runtimeProvider: RuntimeProvider
  runState: ActiveRun
  adoptSession: () => void
  cleanupProvisional: () => void
  finalizeTurnDiff: () => Promise<void>
  cancelTurnDiff: () => Promise<void>
  settled: Promise<void>
}

export interface AppRunExecutionState extends AppRunFrontdoorState {
  request: ReturnType<typeof import('../shared/runtime').normalizeAgentStartRequest>
  options: AppRunStartOptions
  isRemoteRun: boolean
  isWorkflowRun: boolean
  isAuthoringRun: boolean
  providerId: ProviderId
  agentProfileId?: string
  runtimeProvider: RuntimeProvider
  adapter: ProviderAdapter
  toolContentPolicy?: { toolOutput: 'full'; toolContentFieldBytes: number; toolContentTurnBytes: number }
  replica?: WorkflowReplicaRun
  startPerf: PerformanceTrace
  firstTracePerf: PerformanceTrace
  firstTextPerf: PerformanceTrace
  remoteState: { value?: Promise<import('./remote/remote-run-binding').RemoteRunCompletion> }
  assertSessionNotArchived: (sessionIds: readonly (string | null | undefined)[]) => void
}

export interface AppRunTerminalState {
  archiveArgs?: ArchiveTraceTurnArgs
  archiveCommitted: boolean
  managedSettlementAttempted: boolean
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  structuredOutput?: ProviderStructuredOutput
  remoteRecordingFailed: boolean
}

export interface AppRunExecutionDeps {
  sessionBaselineKey: (context: string, sessionId: string) => string
  llmNetworkConfiguration: LlmNetworkConfigurationCache
  homeDir: string
  recordTurn: typeof import('./db').recordTurn
  appSessionStore: () => ReturnType<typeof import('./app-store').createAppSessionStore>
  win: BrowserWindow | null
  rendererCanReceive: () => boolean
  runs: import('./run-registry').RunRegistry<ActiveRun, RunControl>
  queueTrace: (event: TraceEvent) => void
  persistTraceToolEvents: typeof import('./trace-tool-content').persistTraceToolEvents
  getUserData: () => string
  mainEventId: (prefix: string, runId: string) => string
  liveToolContentPolicy: { toolOutput: 'full'; toolContentFieldBytes: number; toolContentTurnBytes: number }
  appendTrace: typeof import('./live-trace').appendCoalescedTrace
  sessionDiffBaselines: import('./session-diff').SessionDiffBaselineRegistry
  dockBadge: { rekey: (from: string, to: string) => void; view: (key: string, focused: boolean) => void; markAttention: (key: string, state: { windowFocused: boolean; sessionViewed: boolean; needsAttention: boolean }) => void }
  providerRegistry: import('./providers/registry').ProviderRegistry
  conversationStore: () => { assertManagedWriteAllowed: (input: { conversationId: string; cwd: string; target: ManagedConversationStart['target']; nativeSessionId?: string; runId: string }) => Promise<void> }
  assertLegacyConversationWriteAllowed: (scope: { providerId: ProviderId; agentProfileId?: string; cwd: string; nativeSessionId?: string }) => Promise<void>
  workflowRunControls: (role: { role: 'worker'; providerId: ProviderId; agentProfileId?: string; requestedModel?: AgentStartRequest['model']; permissionMode?: AgentStartRequest['permissionMode'] }, cwd: string, replica?: WorkflowReplicaRun) => Promise<{ model?: unknown; stop?: unknown; independentRun?: unknown; terminalOutput?: unknown; identity?: string }>
  authorizedMcpExecution: (snapshot: import('./mcp-execution-trust').McpExecutionSnapshot | null) => import('./providers/types').AuthorizedMcpExecution | undefined
  assertWorkflowAuthoringIdentity: typeof import('./workflow-authoring').assertWorkflowAuthoringIdentity
  userQuestionBroker: import('./user-question').UserQuestionBroker
  publishQuestionOpened: (request: AgentQuestionRequest) => void
  publishQuestionClosed: (runId: string, questionId: string) => void
  remoteRunIds: Set<string>
  remoteRunLedgerIds: Map<string, string>
  requestRunStop: (runId: string) => boolean
  flushTraceSend: () => void
  recordingRecoveryHint: string
  recordingBlockedSessions: Map<string, string>
  updateRunAttachmentOwner: typeof import('./attachment-store').updateRunAttachmentOwner
  appendUsage: typeof import('./usage-jsonl').appendUsage
  ensureFailedTerminalResult: typeof import('./run-outcome').ensureFailedTerminalResult
  runTerminationHint: typeof import('../shared/runtime').runTerminationHint
  classifyError: typeof import('./error-classify').classifyError
  terminalOutcomeLabel: typeof import('./run-outcome').terminalOutcomeLabel
  persistTerminalProgress: typeof import('./app-turn-archive').persistTerminalProgress
  archiveTraceTurn: typeof import('./app-turn-archive').archiveTraceTurn
  settleSuccessfulAppRun: typeof import('./app-run-terminal-success').settleSuccessfulAppRun
  settleFailedAppRun: typeof import('./app-run-terminal-failure').settleFailedAppRun
  mirrorSessionTranscript: (providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined) => Promise<void>
  observedTurnTiming: (startedAt: string | undefined, completedAt: string) => { startedAt: string; completedAt: string; durationMs: number } | undefined
  providerRecordingPolicy: typeof import('./provider-recording-policy').providerRecordingPolicy
  archiveSessionId: typeof import('./session-id').archiveSessionId
  runStopLifecycle: import('./run-stop-lifecycle').RunStopLifecycle
  sessionRevisionByContext: Map<string, number>
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  bumpSessionRevision: (key: string) => void
  sourceControl: import('./source-control/service').SourceControlService
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  conversationItemsFromTrace: typeof import('./conversation-history').conversationItemsFromTrace
}

export interface AppRunTerminalDeps {
  terminalState: AppRunTerminalState
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  runId: string
  app: typeof import('electron').app
  agentProfileId?: string
  cwd?: string
  catalogCwd: string
  replica?: WorkflowReplicaRun
  displayPrompt: string
  attachments: PreparedAttachment[]
  runState: ActiveRun
  observedProviderStartedAt?: string
  managedCommitHookEnv?: NodeJS.ProcessEnv
  managedRecorderEnabled: boolean
  toolContentPolicy?: AppRunExecutionState['toolContentPolicy']
  ingestion: LiveTraceIngestion
  emit: (event: TraceEvent) => void
  finalizeTurnDiff: () => Promise<void>
  finalizeSessionDiff: () => Promise<void>
  persistLlmPerformance: (failed: boolean, externalSessionId: string) => Promise<void>
  finishTurnWallTiming: () => TraceEvent
  observedTurnTiming: AppRunExecutionDeps['observedTurnTiming']
  currentObservedSessionId: () => string | undefined
  publishSessionId: (sessionId: string | undefined) => void
  appSessionStore: AppRunExecutionDeps['appSessionStore']
  mirrorSessionTranscript: (providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined) => Promise<void>
  isRemoteRun: boolean
  isWorkflowRun: boolean
  canonicalLifecycle: boolean
  recordingRecoveryHint: string
  recordingBlockedSessions: Map<string, string>
  scopedSessionKey: (sessionId: string) => string
  markTerminalAttention: (sessionId: string, needsAttention: boolean) => void
  persistRunData: (sessionId?: string) => void
  finishRemote: (status: import('./remote/remote-run-binding').RemoteRunCompletion['status'], error?: string) => void
  terminalOutcomeLabel: AppRunExecutionDeps['terminalOutcomeLabel']
  PerformanceTrace: typeof import('./performance-timing').PerformanceTrace
  persistTerminalProgress: AppRunExecutionDeps['persistTerminalProgress']
  archiveTraceTurn: AppRunExecutionDeps['archiveTraceTurn']
  settleManagedConversation: (status: NonNullable<AppRunTerminalState['status']>) => Promise<void>
  updateRunAttachmentOwner: AppRunExecutionDeps['updateRunAttachmentOwner']
  flushTraceSend: () => void
  win: BrowserWindow | null
  resume?: string
  getProviderHandle: () => ProviderRunHandle | null
  interrupted: boolean
  runs: AppRunExecutionDeps['runs']
  queueTrace: (event: TraceEvent) => void
  mainEventId: (prefix: string, runId: string) => string
  appendUsage: AppRunExecutionDeps['appendUsage']
  ensureFailedTerminalResult: AppRunExecutionDeps['ensureFailedTerminalResult']
  runTerminationHint: AppRunExecutionDeps['runTerminationHint']
  classifyError: AppRunExecutionDeps['classifyError']
  providerRecordingPolicy: AppRunExecutionDeps['providerRecordingPolicy']
}
