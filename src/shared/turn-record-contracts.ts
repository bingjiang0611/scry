import type { CreditUsageEvidence } from './credit-usage.js'
import type { TurnDiffStatus, TurnDiffReason, DiffFile, TurnDiffCollection, DangerLevel, CompactionTrigger, WorkspaceOverlapEvidence, WorktreeBaselineReason } from './trace.js'
import type { TurnDiffExcludeEvidence } from './turn-diff.js'
import type { TurnRepositoryLocation } from './turn-repository-location.js'
import type { AgentSteerEvidence, AgentImageMimeType, AgentIntervention } from './runtime.js'
import type { ProviderId } from './provider.js'


export type EvidenceQuality = 'exact' | 'estimated' | 'inferred' | 'unavailable'
export type EvidenceStatus = 'available' | 'partial' | 'disabled' | 'unavailable'

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
  humanInterventionId?: string
}

export interface TurnHookCall {
  order?: number
  lifecycleEvents?: number
  runs?: number
  failed?: number
  event: string
  name?: string
  command?: string
  id?: string
  exitCode?: number
  error?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  status: TurnCallStatus
}

export interface TurnUsage {
  credits?: CreditUsageEvidence
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
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
  status?: 'succeeded' | 'failed' | 'rejected' | 'unknown'
}

export interface TurnDiffSnapshotRecord {
  repositoryLocation?: TurnRepositoryLocation
  status: TurnDiffStatus
  reason?: TurnDiffReason
  files: DiffFile[]
  repoRoot?: string
  requestedRoot?: string
  scope?: string
  beforeAt: string
  afterAt: string
  captureMs: number
  cleanup: 'ok' | 'failed'
  collection?: TurnDiffCollection
  workspaceOverlap?: WorkspaceOverlapEvidence
  baselineSource?: 'worktree-creation-reflog'
  baselineStatus?: 'available' | 'partial'
  baselineCommit?: string
  baselineCreatedAt?: string
  baselineReason?: WorktreeBaselineReason
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

export type TurnSteerEvidence = Omit<AgentSteerEvidence, 'attachments'> & {
  attachments: Array<{ name: string; mimeType: AgentImageMimeType; size: number; sha256: string }>
}

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
    modelTier?: string
    modelStatus?: TurnModelStatus
    modelSource?: TurnModelSource
    modelOmissionReason?: string
  }
  sessionId: string
  providerTurnId?: string
  linkedTaskId?: string | null
  linkedTaskGeneration?: string
  taskLinkStatus?: 'bound' | 'unbound' | 'conflict'
  capture?: {
    protocol: string
    captureId: string
    source: string
    task: string | null
    client?: string
  }
  turnRoleStatus?: TurnRoleStatus
  turnRole?: TurnRole
  generation: number
  turnIndex: number
  startedAt: string
  completedAt: string
  durationMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  termination?: Evidence<TurnTermination>
}

export type TurnModelStatus = 'observed' | 'unobserved' | 'incomplete' | 'conflict'

export type TurnModelSource = 'provider_model_event' | 'usage_event'

export type TurnRoleStatus = 'observed' | 'unobserved' | 'conflict'

export interface TurnRole {
  role: string
  source: string
  parentId?: string
  reviewedSessionId?: string
}

export type TurnEndReason =
  | 'provider_terminal'
  | 'session_end'
  | 'run_ended'
  | 'superseded_by_next_turn'
  | 'expired'

export type TurnCompletedAtSource =
  | 'provider_transcript'
  | 'provider_terminal_event'
  | 'recorder_observed_terminal'
  | 'last_observed_activity'
  | 'turn_start'

export interface TurnTermination {
  reason: TurnEndReason
  completedAtSource: TurnCompletedAtSource
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
