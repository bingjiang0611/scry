import type { AppHint } from '../orchestration-authority-subscribe'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { RunRegistry } from '../../main/run-registry'
import type { RunControl } from '../../main/bootstrap/run-control'
import type { ActiveRun } from '../../shared/trace'
import type { createSessionCatalog } from '../../main/bootstrap/session-catalog'
import type { createWorkspaceRuntime } from '../../main/bootstrap/workspace-runtime'
import type { createProviderRuntime } from '../../main/bootstrap/provider-runtime'
import type { createPiProfileRuntime } from '../../main/bootstrap/pi-profiles'
import type { createSessionState } from '../../main/bootstrap/session-state'
import type { createHistoryRuntime } from '../../main/bootstrap/history-runtime'
import type { createDaemonConversationSend } from '../conversation-send'
import type { createDaemonTerminalService } from '../terminal-service'
import type { DeleteSessionResult } from '../../shared/provider'
import type { DesktopRemoteForkSessionRequest } from '../../shared/desktop-remote'
import type { AgentForkSessionResult } from '../../shared/runtime'
import type { Conversation } from '../../shared/conversation'
import type { ConversationDeletionPreview } from '../../shared/conversation-api'
import type { SourceControlService } from '../../main/source-control/service'
import type { createProviderDiscovery } from '../../main/remote/provider-discovery'
import type { SideChatCascade } from '../../main/bootstrap/conversation-delete'


export interface DaemonLocalEndpointDeps {
  catalog: ReturnType<typeof createSessionCatalog>
  workspace: ReturnType<typeof createWorkspaceRuntime>
  providers: ReturnType<typeof createProviderRuntime>
  pi: ReturnType<typeof createPiProfileRuntime>
  session: ReturnType<typeof createSessionState>
  history: ReturnType<typeof createHistoryRuntime>
  historyChannels: Record<string, (event: unknown, ...args: never[]) => unknown>
  conversationSend: ReturnType<typeof createDaemonConversationSend>
  publishHint: (hint: AppHint) => void
  terminal: ReturnType<typeof createDaemonTerminalService>
  runs: () => RunRegistry<ActiveRun, RunControl>
  startupManagedRecovery: () => Promise<void>
  requestRunStop: (runId: string) => boolean
  remoteHost: () => import('../../main/bootstrap/pairing-channels').PairingHost | null
  forkSessionWithAuthority: (request: DesktopRemoteForkSessionRequest) => Promise<AgentForkSessionResult>
  userDataDir: string
  appVersion: string
  isPackaged: boolean
  sourceControl: SourceControlService
  providerDiscovery: Pick<ReturnType<typeof createProviderDiscovery>, 'invalidate' | 'refreshMetadata'>
  executionTargetBridge?: import('../app-execution-target-bridge').ExecutionTargetBridgeHandlers
  hostAdmin?: import('../host-admin-store').HostAdminStore
  // P8 host metrics: the daemon's own sampler, local scope (may carry the PID).
  hostMetrics?: () => Promise<import('../../shared/host-metrics').HostMetricsSnapshot>
  orchestrationStatus?: () => import('../../shared/background-service').BackgroundServiceOrchestrationStatus
  /** D4: the authority records metadata changes; it is attached after the local ops are built. */
  getOrchestrationAuthority?: () => {
    recordSessionMetadata?: (input: {
      externalSessionId: string
      providerId: string
      agentProfileId?: string | undefined
      cwd: string
      change: { kind: 'rename'; title: string } | { kind: 'pin'; pinned: boolean } | { kind: 'archive'; archived: boolean }
      actor: string
    }) => unknown
  } | undefined
  links?: DaemonSessionLinks
  subscribe?: NonNullable<import('../../main/remote/host-local-ops').LocalEndpointHandlers['subscribe']>
  /** D1: the projection read, plus the one session lookup, so the App can show the host's queue. */
  orchestrationReader?: () => import('../../host-runtime/orchestration/native-session-lookup').SessionReader | undefined
  /** C4: the explicit "继续" is an outbox write, so its handler needs the dispatcher's pump. */
  pumpOrchestration?: () => void
  /** D5: checkpoint capture and rollback; the host owns the git side. */
  checkpoints?: import('../checkpoint-service').CheckpointService
  log?: (line: string) => void
}

export interface DaemonSessionLinks {
  reconcileSessionMetadata?: () => Promise<number>
  deleteNativeProjection?: import('../../main/bootstrap/session-lifecycle').SessionLifecycleDependencies['deleteNativeProjection']
  deleteConversationProjection?: import('../../main/bootstrap/conversation').ConversationTableDependencies['deleteConversationProjection']
  deleteOneSession?: (request: Record<string, unknown>, options: Record<string, unknown>) => Promise<DeleteSessionResult>
  sessionRefFromRequest?: (value: unknown) => import('../../main/app-store').AppSessionRef | null
  changeLegacySessionMetadata?: (
    ref: import('../../main/app-store').AppSessionRef,
    change: () => boolean,
    meta?: {
      change: { kind: 'rename'; title: string } | { kind: 'pin'; pinned: boolean } | { kind: 'archive'; archived: boolean }
      actor: string
    }
  ) => Promise<boolean>
  prepareConversationDeletion?: (conversation: Conversation) => Promise<ConversationDeletionPreview>
  sideChatCascade?: SideChatCascade
}

export type DaemonLocalGroupDeps = DaemonLocalEndpointDeps & { links: DaemonSessionLinks }

export type DaemonLocalOpGroup = (deps: DaemonLocalGroupDeps) => Record<string, LocalOpHandler>

export function withoutEvent(table: Record<string, unknown>): Record<string, LocalOpHandler> {
  return Object.fromEntries(Object.entries(table).map(([channel, listener]) =>
    [channel, ((...args: unknown[]) => (listener as (event: unknown, ...values: unknown[]) => unknown)(undefined, ...args)) as LocalOpHandler]))
}
