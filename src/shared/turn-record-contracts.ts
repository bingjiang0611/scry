import type { CreditUsageEvidence } from './credit-usage.js'
import type { TurnDiffStatus, TurnDiffReason, DiffFile, TurnDiffCollection, DangerLevel, CompactionTrigger, WorkspaceOverlapEvidence, WorktreeBaselineReason } from './trace.js'
import type { TurnDiffExcludeEvidence } from './turn-diff.js'
import type { AgentSteerEvidence, AgentImageMimeType, AgentIntervention } from './runtime.js'
import type { ProviderId } from './provider.js'


export type EvidenceQuality = 'exact' | 'estimated' | 'inferred' | 'unavailable'
export type EvidenceStatus = 'available' | 'partial' | 'disabled' | 'unavailable'

/**
 * Machine-readable causes for a partial evidence section. `omissionReason` stays the human sentence;
 * a code is what a platform, a test or a dashboard matches on, so it must not be parsed out of text.
 */
export const DIFF_OMISSION_CODES = [
  'baseline_after_turn_start',
  'continuation_no_baseline',
  'diff_exclude',
  'untracked_limit',
  'patch_policy',
  'patch_budget',
  'patch_deadline',
  'patch_git_error',
  'patch_truncated',
  'patch_unavailable',
  'snapshot_unavailable'
] as const

export type DiffOmissionCode = (typeof DIFF_OMISSION_CODES)[number]

export interface Evidence<T> {
  status: EvidenceStatus
  quality: EvidenceQuality
  source: string[]
  value?: T
  omissionReason?: string
  /** Only `diff` writes this today: every cause its `omissionReason` names, in the same order. */
  omissionCodes?: DiffOmissionCode[]
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
  /**
   * Set when this call's wall time is human wait rather than execution: the id equals
   * `interventions[].request.questionId`. Consumers that sum tool execution time must leave these
   * calls out; the wait is already reported once, by the intervention's own `durationMs`.
   */
  humanInterventionId?: string
}

export interface TurnHookCall {
  order?: number
  lifecycleEvents?: number
  runs?: number
  /** Legacy: runs before 0.2.75 collapsed failures into a count. New records keep each failed run. */
  failed?: number
  event: string
  name?: string
  command?: string
  /**
   * Provider correlation id of one run (the tool-use id the hook fired on). Only unmerged failed
   * runs carry it: a collapsed success group has no single id to name.
   */
  id?: string
  /**
   * The run's own exit code, verbatim. `-1` is preserved as `-1`; it is not rewritten to a timeout
   * or to success, and a shell `|| true` in the command does not turn a failed run into a success.
   */
  exitCode?: number
  /** Bounded provider error text for this run, quoted not interpreted. */
  error?: string
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
  /**
   * What the turn can prove about this access, one entry per (path, operation):
   * `succeeded` a provider result confirmed it, `failed` the result reported an error, `rejected`
   * the request was denied (by the user or by the host) and never ran, `unknown` no result was
   * observed. Only `succeeded` counts as an observed access. Absent on records written before
   * 0.2.75, which only had the attempt and must keep reading as an observed access.
   */
  status?: 'succeeded' | 'failed' | 'rejected' | 'unknown'
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
  /** 同工作区并行运行的观测证据；缺失 = 旧记录或未观测，不能读成独占归因。 */
  workspaceOverlap?: WorkspaceOverlapEvidence
  /** 本轮新建 worktree 的基线来源；缺失 = 普通回合基线或旧记录。 */
  baselineSource?: 'worktree-creation-reflog'
  baselineStatus?: 'available' | 'partial'
  baselineCommit?: string
  baselineCreatedAt?: string
  baselineReason?: WorktreeBaselineReason
  /**
   * 接入方为这次会话声明的 diff 排除：实际命中的路径与因此没进 `files` 的文件数。
   * 只记路径和数量，不记文件正文；缺失 = 这次 diff 没有因声明少任何文件。
   */
  diffExclude?: TurnDiffExcludeEvidence
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
  worktreeDiscovery?: {
    probedRepositories: number
    skippedRepositories: number
    discoveredWorktrees: number
    incomplete: true
  }
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
    /** Provider-reported logical tier, separate from a concrete native model id. */
    modelTier?: string
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
   * Session-capture provenance. Present only for turns recorded under an explicit claim, so a record
   * states which claim opened the session, why, and which task string the caller supplied. Absent
   * means ordinary recording — never "captured without a claim".
   */
  capture?: {
    protocol: string
    captureId: string
    /** Verbatim caller string; it is not interpreted as a REQ or any other identifier. */
    source: string
    task: string | null
    /**
     * The client application the host ran inside, when it was observed (`3eye`, `qoder`, …). It is
     * independent of `source`: a workflow that wraps 3eye records both, and absent means unobserved.
     */
    client?: string
  }
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

/** `observed` is the only status that permits reading provider model metadata as fact. */
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

const DECIMAL_20_8_LIMIT = 1_000_000_000_000

export function canonicalCostUsd(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0 || value >= DECIMAL_20_8_LIMIT) return undefined
  const rounded = Number(value.toFixed(8))
  if (!Number.isFinite(rounded) || rounded >= DECIMAL_20_8_LIMIT) return undefined
  return Object.is(rounded, -0) ? 0 : rounded
}
