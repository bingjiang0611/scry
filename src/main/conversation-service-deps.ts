import type { ConversationArchiveRef, ConversationBinding, Conversation, ConversationItemRef, ConversationTarget } from '../shared/conversation'
import type { HistoryReaderConnection } from './conversation-history-reader'
import type { PreparedAttachment } from './attachment-store'
import type { ProviderHistoricalContext, ProviderInputReceipt } from './providers/types'
import type { AgentStartRequest } from '../shared/runtime'
import type { LoadedSessionTurn } from './session-history'
import type { ProviderId } from '../shared/provider'
import type { TraceEvent } from '../shared/trace'
import type { StreamedTurn } from './conversation-side-chat-stream'
import type { ConversationStore } from './conversation-store'

/** Catalog-verified composite identity of a read-only native side-chat source. */
export interface SideChatNativeSource {
  providerId: ProviderId
  agentProfileId?: string
  /** Canonicalized project directory; never a renderer-supplied path. */
  cwd: string
  nativeSessionId: string
}

/** One Provider-native turn read by an existing bounded reader; never executed. */
export interface SideChatNativeTurn {
  runId: string
  providerTurnId?: string
  /**
   * Terminal marker the Provider wrote on this turn's last assistant message
   * (Claude `stop_reason`, Pi `stopReason`). Absent when the reader proves none,
   * so visible text alone is never treated as a finished turn.
   */
  stopReason?: string
  userText: string
  items: TraceEvent[]
}

/**
 * Read-only native source seam at the main service boundary. Implementations must
 * resolve identity from the App catalog and must not start a Provider, mutate
 * ownership or write a trace archive. `null` means this build has no verified
 * native reader for that Provider.
 */
export interface SideChatSourceDeps {
  /** Required: a native source without a verified catalog identity is not evidence. */
  assertNativeSource: (source: SideChatNativeSource) => Promise<void>
  /**
   * Optional: a Provider whose transcript can be projected record by record. Bodies stay
   * spooled, so a single huge tool result never becomes a value in memory.
   */
  streamNativeTurns?: (source: SideChatNativeSource) => Promise<AsyncGenerator<StreamedTurn> | null>
  /** Optional: a Provider whose own reader only returns whole turns. */
  readNativeTurns?: (source: SideChatNativeSource) => Promise<SideChatNativeTurn[] | null>
}

/** Narrow view of the service dependencies the local-only side-chat operations use. */
export type SideChatServiceDeps = Pick<ConversationServiceDeps,
  'store' | 'supportsHistoricalInput' | 'supportsHistoryReader' | 'sideChatSource'>

export interface ConversationTerminal {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  receipt?: ProviderInputReceipt
  finalItems: ConversationItemRef[]
  archive?: ConversationArchiveRef
}

export interface ManagedConversationStart {
  conversationId: string
  runId: string
  target: ConversationTarget
  resumeSessionId: string | null
  historicalContext?: ProviderHistoricalContext
  historyReader?: HistoryReaderConnection
  historyBudget?: import('./providers/types').ProviderRunRequest['historyBudget']
  /** Main calls this after materializing native attachments, before dispatch. */
  prepareInput: (attachments: PreparedAttachment[]) => { prompt: string; inputTextHash: string }
  /** Hash of the supported text/image/native settings scope frozen before launch. */
  requestHash: string
  inputTextHash: string
  /** Exact request fingerprint persisted in the durable command intent. */
  payloadHash: string
  onProviderDispatchAttempt?: () => void
  onTerminal: (terminal: ConversationTerminal) => Promise<void>
}

export interface ConversationServiceDeps {
  store: ConversationStore
  resolveContinuationKey: (context: { providerId: ProviderId; cwd: string; agentProfileId?: string }) => Promise<string>
  supportsHistoricalInput: (providerId: ProviderId) => boolean
  supportsHistoryReader?: (providerId: ProviderId) => boolean
  startAppRun: (request: AgentStartRequest, options: { managedConversation: ManagedConversationStart }) => Promise<{ runId: string }>
  forkNative?: (request: { source: Conversation; binding: ConversationBinding; turn: Conversation['turns'][number]; permissionMode: AgentStartRequest['permissionMode']; beforeFork: () => Promise<void> }) => Promise<string>
  loadItemText?: (conversation: Conversation, ref: ConversationItemRef) => Promise<string>
  /**
   * Batch projection of archived turns for one visible page. A page can hold 40 turns of
   * the same native session, so the loader reads each session once instead of per turn.
   */
  loadTurns?: (conversation: Conversation, turns: readonly Conversation['turns'][number][]) => Promise<ReadonlyMap<string, LoadedSessionTurn>>
  sideChatSource?: SideChatSourceDeps
}
