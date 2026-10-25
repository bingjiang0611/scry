import type { CreditUsageEvidence } from './credit-usage.js'
import type { TurnDiffStatus, TurnDiffReason, DiffFile, TurnDiffCollection, DangerLevel, CompactionTrigger } from './trace.js'
import type { AgentSteerEvidence, AgentImageMimeType, AgentIntervention } from './runtime.js'
import type { ProviderId } from './provider.js'


export type EvidenceQuality = 'exact' | 'estimated' | 'inferred' | 'unavailable'
export type EvidenceStatus = 'available' | 'partial' | 'disabled' | 'unavailable'

export interface Evidence<T> {
  status: EvidenceStatus
  quality: EvidenceQuality
  source: string[]
  value?: T
  omissionReason?: string
}

export type TurnCallStatus = 'started' | 'success' | 'failed' | 'cancelled' | 'unknown'

export interface TurnCall {
  inputContent?: import('./tool-content.js').ToolContent
  outputContent?: import('./tool-content.js').ToolContent
  id?: string
  parentId?: string
  category?: 'tool' | 'skill' | 'agent' | 'mcp'
  order?: number
  completedOrder?: number
  name: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  status: TurnCallStatus
  input?: unknown
  outputSummary?: string
  error?: string
  file?: { operation: 'read' | 'write' | 'edit'; path: string }
  mcp?: { server?: string; action?: string; tool?: string }
}

export interface TurnHookCall {
  order?: number
  lifecycleEvents?: number
  runs?: number
  failed?: number
  event: string
  name?: string
  command?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  status: TurnCallStatus
}

export interface TurnUsage {
  /** Independent unit and coverage; never included in costUsd. */
  credits?: CreditUsageEvidence
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  /** Canonical writers emit a non-negative DECIMAL(20,8)-compatible value. */
  costUsd?: number
  apiDurationMs?: number
  contextTokens?: number
  contextWindow?: number
  contextModel?: string
  contextProvider?: string
  contextUsageSource?: string
  contextUsageQuality?: 'exact' | 'inferred'
  model?: string
}

export type TurnModelTimingMethod = 'provider_api' | 'response_intervals' | 'non_call_residual'

export interface TurnModelCallTiming {
  responseId?: string
  scope: 'root' | 'subagent'
  agentId?: string
  parentToolUseId?: string
  startedAt?: string
  completedAt: string
  durationMs?: number
  source: 'provider' | 'observed'
  boundary?: 'turn_or_activity_end'
}

export interface TurnModelTimingLane {
  totalCalls: number
  timedCalls: number
  cumulativeMs?: number
}

export interface TurnModelTiming {
  method: TurnModelTimingMethod
  cumulativeMs?: number
  occupiedMs?: number
  overlapMs?: number
  totalCalls?: number
  timedCalls?: number
  root?: TurnModelTimingLane
  subagents?: TurnModelTimingLane
  calls?: TurnModelCallTiming[]
  activityCoverage?: { timedCalls: number; totalCalls: number }
}

export interface TurnModelSegment {
  order: number
  at: string
  kind: 'text' | 'thinking'
  /** Bounded inline projection; reconstruct the complete segment from ordered contentRefs. */
  text: string
  contentRefs?: import('./tool-content.js').ToolContentRef[]
  messageId?: string
  providerItemId?: string
  parentId?: string
  agentId?: string
}

export interface TurnTranscriptSource {
  contentRef: import('./tool-content.js').ContentRef
  sourcePath: string
  startOffset: number
  endOffset: number
  identity: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
  sourceCompleteness: 'complete' | 'partial'
}

export interface TurnFile {
  path: string
  operation: 'read' | 'write' | 'edit'
}

export interface TurnDiffSnapshotRecord {
  status: TurnDiffStatus
  reason?: TurnDiffReason
  files: DiffFile[]
  repoRoot?: string
  /** Requested capture directory from discovery; Git may not have resolved repoRoot. */
  requestedRoot?: string
  scope?: string
  beforeAt: string
  afterAt: string
  captureMs: number
  cleanup: 'ok' | 'failed'
  collection?: TurnDiffCollection
}

export interface TurnDanger {
  level: DangerLevel
  reason: string
  tool?: string
  toolUseId?: string
}

export interface TurnError {
  message: string
  source: string
  toolUseId?: string
}

export interface TurnCompaction {
  eventId: string
  at: string
  trigger?: CompactionTrigger
  preTokens?: number
  postTokens?: number
  durationMs?: number
  agentId?: string
}

/** Full payloads stay in the trace archive; workspace records retain content identity. */
export type TurnSteerEvidence = Omit<AgentSteerEvidence, 'attachments'> & {
  attachments: Array<{ name: string; mimeType: AgentImageMimeType; size: number; sha256: string }>
}

/** Observed request directories under the configured discovery scope, not all repositories on disk. */
export interface TurnRepositoryDiscovery {
  requestedRoots: string[]
  maxDepth: number
  depthLimitedDirectories: number
}

export interface TurnEvidence {
  user: Evidence<{ text?: string; textHash?: string; steers?: TurnSteerEvidence[] }>
  assistant: Evidence<{ text?: string; textHash?: string; contentRefs?: import('./tool-content.js').ToolContentRef[] }>
  tools: Evidence<TurnCall[]>
  skills: Evidence<TurnCall[]>
  mcps: Evidence<TurnCall[]>
  hooks: Evidence<TurnHookCall[]>
  usage: Evidence<TurnUsage>
  compactions?: Evidence<TurnCompaction[]>
  modelSegments?: Evidence<TurnModelSegment[]>
  modelTiming?: Evidence<TurnModelTiming>
  /** Immutable bytes used by the per-turn parser, separate from mutable Provider files. */
  transcript?: Evidence<TurnTranscriptSource>
  files: Evidence<TurnFile[]>
  diff: Evidence<TurnDiffSnapshotRecord[]> & { discovery?: TurnRepositoryDiscovery }
  dangerousOperations: Evidence<TurnDanger[]>
  errors: Evidence<TurnError[]>
  interventions?: Evidence<AgentIntervention[]>
}

export interface AgentTurnRecord extends TurnEvidence {
  schemaVersion: 1
  recordKind: 'agent_turn'
  sequence: number
  recordId: string
  recorderVersion: string
  workspace: { id: string; root: string }
  provider: {
    id: ProviderId
    version?: string
    model?: string
    /**
     * Why `model` reads the way it does. A missing model has several distinct
     * causes and they are not interchangeable: the provider may never expose
     * one, may expose an incomplete observation, or may report several in one
     * turn. Absence of this field is legacy, not a claim that the model was
     * observed, and no status ever licenses inferring a requested model.
     */
    modelStatus?: TurnModelStatus
    /** Where an observed model came from. Absent unless `modelStatus` is `observed`. */
    modelSource?: TurnModelSource
    /** Required whenever the model is not `observed`; never a guess at the real model. */
    modelOmissionReason?: string
  }
  sessionId: string
  providerTurnId?: string
  /** Explicit caller association; null means no association, never infer it from prompt text. */
  linkedTaskId?: string | null
  linkedTaskGeneration?: string
  taskLinkStatus?: 'bound' | 'unbound' | 'conflict'
  /**
   * Whether this turn's role in the session was structurally observed.
   *
   * `unobserved` is the honest default: a provider that reports no role gives
   * no basis for calling a record a main-agent user turn, and prompt text is
   * never a role boundary. A consumer must not build a main-turn denominator
   * out of `unobserved` records.
   */
  turnRoleStatus?: TurnRoleStatus
  /** Structural role supplied by the host; only present when `turnRoleStatus` is `observed`. */
  turnRole?: TurnRole
  generation: number
  turnIndex: number
  startedAt: string
  /** Best credible end of Agent work. Read `termination` before treating it, or `durationMs`, as exact. */
  completedAt: string
  durationMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  /** Absent in records written before 0.2.38; absence is legacy, not proof of a trusted end time. */
  termination?: Evidence<TurnTermination>
}

/** `observed` is the only status that permits reading `provider.model` as fact. */
export type TurnModelStatus = 'observed' | 'unobserved' | 'incomplete' | 'conflict'

/** Provenance of an observed model id. `usage_event` is a billed model, not a requested one. */
export type TurnModelSource = 'provider_model_event' | 'usage_event'

export type TurnRoleStatus = 'observed' | 'unobserved' | 'conflict'

export interface TurnRole {
  /** Structural role of this turn, e.g. `main`, `approval`, `guardian`, `subagent`. */
  role: string
  /** What supplied the role, e.g. the integration or host component name. */
  source: string
  /** Parent turn or run identity when the host knows it. */
  parentId?: string
  /** Session this turn reviewed, for review/approval roles. */
  reviewedSessionId?: string
}

export type TurnEndReason =
  | 'provider_terminal'
  | 'session_end'
  /** The App-driven run ended without a Provider terminal, e.g. a cancelled managed run. */
  | 'run_ended'
  | 'superseded_by_next_turn'
  | 'expired'

/**
 * How `completedAt` was established. The arrival of a later unrelated event — notably the next
 * turn's prompt — is never an end time: it would bill idle user time as Agent work.
 */
export type TurnCompletedAtSource =
  | 'provider_transcript'
  | 'provider_terminal_event'
  | 'recorder_observed_terminal'
  | 'last_observed_activity'
  | 'turn_start'

export interface TurnTermination {
  reason: TurnEndReason
  completedAtSource: TurnCompletedAtSource
  /** When Scry observed the end. This is not the turn's end time. */
  observedAt?: string
}

export interface TurnRecordValidationIssue {
  path: string
  message: string
}

export type TurnRecordValidationResult =
  | { ok: true; record: AgentTurnRecord }
  | { ok: false; issues: TurnRecordValidationIssue[] }
