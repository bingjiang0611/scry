import type { AgentQuestionRequest, AgentIntervention } from '../../shared/runtime'
import type { RunRendererSink } from './trace-runtime'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import type { ProviderRegistry } from '../providers/registry'
import type { PiRunDiagnostics } from '../providers/pi-run-diagnostics'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { ContextAdmission } from '../context-admission'
import type { ConversationStore, NativeSessionScope } from '../conversation-store'
import type { createAppSessionStore } from '../app-store'
import type { RunRegistry } from '../run-registry'
import type { RunStopLifecycle } from '../run-stop-lifecycle'
import type { RunTraceRouter } from '../run-trace-router'
import type { UserQuestionBroker } from '../user-question'
import type { DockBadgeState } from '../dock-badge'
import type { SourceControlService } from '../source-control/service'
import type { LlmNetworkConfigurationCache } from '../llm-network-configuration'
import type { SessionDiffBaselineRegistry } from '../session-diff'
import type { createLiveRunState } from './run-live-state'
import type { RunControl } from './run-control'

/** What the run pipeline needs from the process that hosts it (Electron main or the daemon). */
export type RunHost = {
  providerRegistry: ProviderRegistry
  piRunDiagnostics: PiRunDiagnostics
  isShuttingDown: () => boolean
  getCurrentCwd: () => string | undefined
  renderer: RunRendererSink
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  resolveRemoteProjectDirectory: (cwd: string) => string
  resolveKnownProjectDirectory: (cwd: string) => string
  providerOperationGate: ProviderOperationGate
  providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, profile?: string) => string
  contextAdmission: ContextAdmission
  getStartupManagedRecovery: () => Promise<void>
  resetSessionContext: (key: string) => void
  sessionRevisionByContext: Map<string, number>
  sessionByContext: Map<string, string>
  sessionAliasesByContext: Map<string, Map<string, string>>
  runs: RunRegistry<ActiveRun, RunControl>
  deletingSessions: Set<string>
  conversationStore: () => ConversationStore
  assertLegacyConversationWriteAllowed: (scope: NativeSessionScope) => Promise<void>
  recordingBlockedSessions: Map<string, string>
  homeDir: string
  nextRunSequence: () => number
  llmNetworkConfiguration: LlmNetworkConfigurationCache
  sessionDiffBaselines: SessionDiffBaselineRegistry
  publishTrace: (event: TraceEvent) => void
  rendererCanReceive: () => boolean
  mainEventId: (prefix: string, runId: string) => string
  LIVE_TOOL_CONTENT_POLICY: Parameters<typeof createLiveRunState>[0]['LIVE_TOOL_CONTENT_POLICY']
  recordingRecoveryHint: string
  sessionBaselineKey: (context: string, sessionId: string) => string
  dockBadge: DockBadgeState
  userQuestionBroker: UserQuestionBroker
  publishQuestionOpened: (request: AgentQuestionRequest) => void
  publishQuestionClosed: (runId: string, questionId: string, intervention?: AgentIntervention) => void
  requestRunStop: (runId: string) => boolean
  bumpSessionRevision: (key: string) => void
  sourceControl: SourceControlService
  remoteRunIds: Set<string>
  remoteRunLedgerIds: Map<string, string>
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  forgetBoundedRun: (runId: string) => void
  mirrorSessionTranscript: (providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined) => Promise<void>
  flushTraceSend: () => void
  runStopLifecycle: RunStopLifecycle
  runTraces: Pick<RunTraceRouter, 'settle' | 'hasDemand'>
}
