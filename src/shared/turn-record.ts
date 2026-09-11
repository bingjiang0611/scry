import type { ProviderId } from './provider.js'
import { isCreditUsageEvidence, type CreditUsageEvidence } from './credit-usage.js'
import { isToolContent } from './tool-content.js'
import { normalizeTurnDiffSnapshot, type CompactionTrigger, type DangerLevel, type DiffFile, type TurnDiffCollection, type TurnDiffReason, type TurnDiffStatus } from './trace.js'
import type { AgentIntervention } from './runtime.js'

export type EvidenceQuality = 'exact' | 'estimated' | 'inferred' | 'unavailable'
export type EvidenceStatus = 'available' | 'partial' | 'disabled' | 'unavailable'

const DECIMAL_20_8_LIMIT = 1_000_000_000_000

export function canonicalCostUsd(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0 || value >= DECIMAL_20_8_LIMIT) return undefined
  const rounded = Number(value.toFixed(8))
  if (!Number.isFinite(rounded) || rounded >= DECIMAL_20_8_LIMIT) return undefined
  return Object.is(rounded, -0) ? 0 : rounded
}

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
  text: string
  messageId?: string
  providerItemId?: string
  parentId?: string
  agentId?: string
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

export interface TurnEvidence {
  user: Evidence<{ text?: string; textHash?: string }>
  assistant: Evidence<{ text?: string; textHash?: string }>
  tools: Evidence<TurnCall[]>
  skills: Evidence<TurnCall[]>
  mcps: Evidence<TurnCall[]>
  hooks: Evidence<TurnHookCall[]>
  usage: Evidence<TurnUsage>
  compactions?: Evidence<TurnCompaction[]>
  modelSegments?: Evidence<TurnModelSegment[]>
  modelTiming?: Evidence<TurnModelTiming>
  files: Evidence<TurnFile[]>
  diff: Evidence<TurnDiffSnapshotRecord[]>
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

function isTurnTermination(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return ['provider_terminal', 'session_end', 'run_ended', 'superseded_by_next_turn', 'expired'].includes(String(raw.reason)) &&
    ['provider_transcript', 'provider_terminal_event', 'recorder_observed_terminal', 'last_observed_activity', 'turn_start'].includes(String(raw.completedAtSource)) &&
    (raw.observedAt === undefined || isDateString(raw.observedAt))
}

/** Sections every record must carry, followed by the optional ones. Single source of truth for
 * validation and for any surface that reports per-section evidence status. */
export const REQUIRED_EVIDENCE_SECTIONS = [
  'user', 'assistant', 'tools', 'skills', 'mcps', 'hooks', 'usage', 'files', 'diff',
  'dangerousOperations', 'errors'
] as const

export const OPTIONAL_EVIDENCE_SECTIONS = ['interventions', 'compactions', 'modelSegments', 'modelTiming', 'termination'] as const

/** `status/quality` per section; a missing optional section reads as unavailable, never as empty. */
export function evidenceStatusMap(record: AgentTurnRecord): Record<string, string> {
  const summary: Record<string, string> = {}
  for (const section of [...REQUIRED_EVIDENCE_SECTIONS, ...OPTIONAL_EVIDENCE_SECTIONS]) {
    const evidence = record[section] as Evidence<unknown> | undefined
    summary[section] = evidence ? `${evidence.status}/${evidence.quality}` : 'unavailable/unavailable'
  }
  return summary
}

export function available<T>(value: T, source: string[], quality: EvidenceQuality = 'exact'): Evidence<T> {
  return { status: 'available', quality, source, value }
}

export function unavailable<T>(reason: string, source: string[] = []): Evidence<T> {
  return { status: 'unavailable', quality: 'unavailable', source, omissionReason: reason }
}

export function disabled<T>(reason: string): Evidence<T> {
  return { status: 'disabled', quality: 'unavailable', source: ['config'], omissionReason: reason }
}

export function partial<T>(value: T, source: string[], reason: string, quality: EvidenceQuality = 'inferred'): Evidence<T> {
  return { status: 'partial', quality, source, value, omissionReason: reason }
}

function isEvidence(value: unknown): value is Evidence<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!['available', 'partial', 'disabled', 'unavailable'].includes(String(raw.status))) return false
  if (!['exact', 'estimated', 'inferred', 'unavailable'].includes(String(raw.quality))) return false
  if (!Array.isArray(raw.source) || !raw.source.every((source) => typeof source === 'string' && source.length > 0)) return false
  if (raw.omissionReason !== undefined && (typeof raw.omissionReason !== 'string' || raw.omissionReason.length === 0)) return false
  if (raw.status === 'available') return raw.value !== undefined && raw.quality !== 'unavailable' && raw.source.length > 0
  if (raw.status === 'partial') return raw.value !== undefined && raw.quality !== 'unavailable' && typeof raw.omissionReason === 'string' && raw.source.length > 0
  // Early schema-v1 writers omitted omissionReason, so readers retain that historical compatibility.
  return raw.quality === 'unavailable'
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isModelTimingLane(value: unknown): value is TurnModelTimingLane {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    Number.isSafeInteger(raw.totalCalls) &&
    Number(raw.totalCalls) >= 0 &&
    Number.isSafeInteger(raw.timedCalls) &&
    Number(raw.timedCalls) >= 0 &&
    Number(raw.timedCalls) <= Number(raw.totalCalls) &&
    (raw.cumulativeMs === undefined || isNonNegativeNumber(raw.cumulativeMs))
  )
}

function isModelTimingCall(value: unknown): value is TurnModelCallTiming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    ['root', 'subagent'].includes(String(raw.scope)) &&
    isDateString(raw.completedAt) &&
    ['provider', 'observed'].includes(String(raw.source)) &&
    (raw.durationMs === undefined || isNonNegativeNumber(raw.durationMs)) &&
    (raw.boundary === undefined || raw.boundary === 'turn_or_activity_end')
  )
}

function isActivityCoverage(value: unknown): value is TurnModelTiming['activityCoverage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    Number.isSafeInteger(raw.totalCalls) &&
    Number(raw.totalCalls) >= 0 &&
    Number.isSafeInteger(raw.timedCalls) &&
    Number(raw.timedCalls) >= 0 &&
    Number(raw.timedCalls) <= Number(raw.totalCalls)
  )
}

function isModelTiming(value: unknown): value is TurnModelTiming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!['provider_api', 'response_intervals', 'non_call_residual'].includes(String(raw.method))) return false
  for (const key of ['cumulativeMs', 'occupiedMs', 'overlapMs']) {
    if (raw[key] !== undefined && !isNonNegativeNumber(raw[key])) return false
  }
  for (const key of ['totalCalls', 'timedCalls']) {
    if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) return false
  }
  if (
    raw.totalCalls !== undefined &&
    raw.timedCalls !== undefined &&
    Number(raw.timedCalls) > Number(raw.totalCalls)
  ) return false
  if (raw.root !== undefined && !isModelTimingLane(raw.root)) return false
  if (raw.subagents !== undefined && !isModelTimingLane(raw.subagents)) return false
  if (raw.calls !== undefined && (!Array.isArray(raw.calls) || !raw.calls.every(isModelTimingCall))) return false
  if (raw.activityCoverage !== undefined && !isActivityCoverage(raw.activityCoverage)) return false
  return true
}

function isModelTimingEvidence(value: unknown): value is Evidence<TurnModelTiming> {
  if (!isEvidence(value)) return false
  const raw = value as Evidence<unknown>
  if (raw.status === 'available' || raw.status === 'partial') return isModelTiming(raw.value)
  return raw.value === undefined || isModelTiming(raw.value)
}

function isModelSegment(value: unknown): value is TurnModelSegment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    Number.isSafeInteger(raw.order) &&
    Number(raw.order) >= 0 &&
    isDateString(raw.at) &&
    (raw.kind === 'text' || raw.kind === 'thinking') &&
    typeof raw.text === 'string' &&
    raw.text.length > 0 &&
    (raw.messageId === undefined || typeof raw.messageId === 'string') &&
    (raw.providerItemId === undefined || typeof raw.providerItemId === 'string') &&
    (raw.parentId === undefined || typeof raw.parentId === 'string') &&
    (raw.agentId === undefined || typeof raw.agentId === 'string')
  )
}

function isModelSegmentsEvidence(value: unknown): value is Evidence<TurnModelSegment[]> {
  if (!isEvidence(value)) return false
  const raw = value as Evidence<unknown>
  if (raw.value === undefined) return raw.status !== 'available' && raw.status !== 'partial'
  return Array.isArray(raw.value) && raw.value.every(isModelSegment)
}

function isCompaction(value: unknown): value is TurnCompaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.eventId === 'string' &&
    raw.eventId.length > 0 &&
    isDateString(raw.at) &&
    (raw.trigger === undefined || raw.trigger === 'auto' || raw.trigger === 'manual') &&
    (raw.preTokens === undefined || isNonNegativeNumber(raw.preTokens)) &&
    (raw.postTokens === undefined || isNonNegativeNumber(raw.postTokens)) &&
    (raw.durationMs === undefined || isNonNegativeNumber(raw.durationMs)) &&
    (raw.agentId === undefined || typeof raw.agentId === 'string')
  )
}

function isCompactionsEvidence(value: unknown): value is Evidence<TurnCompaction[]> {
  if (!isEvidence(value)) return false
  const raw = value as Evidence<unknown>
  if (raw.value === undefined) return raw.status !== 'available' && raw.status !== 'partial'
  return Array.isArray(raw.value) && raw.value.every(isCompaction)
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isEvidencePayload(value: unknown, validate: (payload: unknown) => boolean, allowUnavailableValue = false): boolean {
  if (!isEvidence(value)) return false
  const evidence = value as Evidence<unknown>
  if (evidence.status === 'available' || evidence.status === 'partial') return validate(evidence.value)
  return evidence.value === undefined || (allowUnavailableValue && validate(evidence.value))
}

function isTextPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return isOptionalString(raw.text) && isOptionalString(raw.textHash)
}

function isTurnCall(value: unknown): value is TurnCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string' || !raw.name || !['started', 'success', 'failed', 'cancelled', 'unknown'].includes(String(raw.status))) return false
  if (raw.inputContent !== undefined && !isToolContent(raw.inputContent)) return false
  if (raw.outputContent !== undefined && !isToolContent(raw.outputContent)) return false
  if (raw.category !== undefined && !['tool', 'skill', 'agent', 'mcp'].includes(String(raw.category))) return false
  for (const key of ['order', 'completedOrder']) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) return false
  if (raw.durationMs !== undefined && !isNonNegativeNumber(raw.durationMs)) return false
  if (raw.startedAt !== undefined && !isDateString(raw.startedAt)) return false
  if (raw.completedAt !== undefined && !isDateString(raw.completedAt)) return false
  if (!['id', 'parentId', 'outputSummary', 'error'].every((key) => isOptionalString(raw[key]))) return false
  if (raw.file !== undefined) {
    if (!raw.file || typeof raw.file !== 'object' || Array.isArray(raw.file)) return false
    const file = raw.file as Record<string, unknown>
    if (typeof file.path !== 'string' || !['read', 'write', 'edit'].includes(String(file.operation))) return false
  }
  if (raw.mcp !== undefined) {
    if (!raw.mcp || typeof raw.mcp !== 'object' || Array.isArray(raw.mcp)) return false
    const mcp = raw.mcp as Record<string, unknown>
    if (!['server', 'action', 'tool'].every((key) => isOptionalString(mcp[key]))) return false
  }
  return true
}

function isTurnHook(value: unknown): value is TurnHookCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (typeof raw.event !== 'string' || !raw.event || !['started', 'success', 'failed', 'cancelled', 'unknown'].includes(String(raw.status))) return false
  for (const key of ['order', 'lifecycleEvents', 'runs', 'failed']) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) return false
  if (raw.durationMs !== undefined && !isNonNegativeNumber(raw.durationMs)) return false
  if (raw.startedAt !== undefined && !isDateString(raw.startedAt)) return false
  if (raw.completedAt !== undefined && !isDateString(raw.completedAt)) return false
  return ['name', 'command'].every((key) => isOptionalString(raw[key]))
}

function isTurnUsage(value: unknown): value is TurnUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'reasoningTokens', 'apiDurationMs', 'contextTokens', 'contextWindow']) {
    if (raw[key] !== undefined && !isNonNegativeNumber(raw[key])) return false
  }
  if (raw.credits !== undefined && !isCreditUsageEvidence(raw.credits)) return false
  if (raw.costUsd !== undefined && canonicalCostUsd(raw.costUsd as number) !== raw.costUsd) return false
  if (raw.contextUsageQuality !== undefined && !['exact', 'inferred'].includes(String(raw.contextUsageQuality))) return false
  return ['contextModel', 'contextProvider', 'contextUsageSource', 'model'].every((key) => isOptionalString(raw[key]))
}

function isTurnFile(value: unknown): value is TurnFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return typeof raw.path === 'string' && raw.path.length > 0 && ['read', 'write', 'edit'].includes(String(raw.operation))
}

function isTurnDiff(value: unknown): value is TurnDiffSnapshotRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  const normalized = normalizeTurnDiffSnapshot({ version: 1, ...raw })
  return !!normalized && Array.isArray(raw.files) && normalized.files.length === raw.files.length
}

function isTurnDanger(value: unknown): value is TurnDanger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return ['danger', 'warn'].includes(String(raw.level)) && typeof raw.reason === 'string' && raw.reason.length > 0 &&
    isOptionalString(raw.tool) && isOptionalString(raw.toolUseId)
}

/** Roles are bounded identifiers, never free-form prose lifted from a prompt. */
function isTurnRole(value: unknown): value is TurnRole {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  const bounded = (input: unknown) => typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(input)
  return bounded(raw.role) && bounded(raw.source) &&
    (raw.parentId === undefined || bounded(raw.parentId)) &&
    (raw.reviewedSessionId === undefined || bounded(raw.reviewedSessionId))
}

function isTurnError(value: unknown): value is TurnError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return typeof raw.message === 'string' && raw.message.length > 0 && typeof raw.source === 'string' && raw.source.length > 0 && isOptionalString(raw.toolUseId)
}

function isQuestionOption(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return typeof raw.label === 'string' && raw.label.length > 0 && raw.label.length <= 240 &&
    typeof raw.description === 'string' && raw.description.length > 0 && raw.description.length <= 4_000 &&
    (raw.preview === undefined || (typeof raw.preview === 'string' && raw.preview.length > 0 && raw.preview.length <= 20_000))
}

function isQuestionPrompt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (typeof raw.question !== 'string' || raw.question.length === 0 || raw.question.length > 2_000) return false
  if (typeof raw.header !== 'string' || raw.header.length === 0 || raw.header.length > 120) return false
  if (!Array.isArray(raw.options) || raw.options.length > 4 || !raw.options.every(isQuestionOption) || typeof raw.multiSelect !== 'boolean') return false
  const labels = raw.options.map((option) => (option as Record<string, unknown>).label)
  return new Set(labels).size === labels.length
}

function isQuestionRequest(value: unknown): value is Record<string, unknown> & { questions: Array<Record<string, unknown>> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return typeof raw.runId === 'string' && raw.runId.length > 0 &&
    typeof raw.questionId === 'string' && raw.questionId.length > 0 &&
    (raw.providerId === undefined || ['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(String(raw.providerId))) &&
    isOptionalString(raw.agentId) && isOptionalString(raw.source) &&
    (raw.questionKind === undefined || ['clarification', 'permission'].includes(String(raw.questionKind))) &&
    Array.isArray(raw.questions) && raw.questions.length > 0 && raw.questions.length <= 4 && raw.questions.every(isQuestionPrompt) &&
    new Set(raw.questions.map((question) => (question as Record<string, unknown>).question)).size === raw.questions.length
}

function isQuestionResponse(value: unknown, request: Record<string, unknown> & { questions: Array<Record<string, unknown>> }): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (raw.runId !== request.runId || raw.questionId !== request.questionId) return false
  if (raw.behavior === 'cancelled') return raw.answers === undefined
  if (raw.behavior !== 'answered' || !raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)) return false
  const answers = raw.answers as Record<string, unknown>
  if (!Object.values(answers).every((answer) => typeof answer === 'string' && answer.length > 0 && answer.length <= 4_000)) return false
  return request.questions.every((question) => typeof question.question === 'string' && typeof answers[question.question] === 'string')
}

function isIntervention(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!['clarification', 'permission'].includes(String(raw.kind)) || typeof raw.source !== 'string' || raw.source.length === 0) return false
  if (!['answered', 'user_cancelled', 'provider_cancelled'].includes(String(raw.resolution))) return false
  if (!isDateString(raw.openedAt) || !isDateString(raw.closedAt) || Date.parse(raw.closedAt) < Date.parse(raw.openedAt) || !isNonNegativeNumber(raw.durationMs)) return false
  if (!isQuestionRequest(raw.request) || !isQuestionResponse(raw.response, raw.request)) return false
  if (raw.request.questionKind !== undefined && raw.request.questionKind !== raw.kind) return false
  const response = raw.response as Record<string, unknown>
  return raw.resolution === 'answered' ? response.behavior === 'answered' : response.behavior === 'cancelled'
}

function isArrayOf(value: unknown, validate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(validate)
}

export interface TurnRecordValidationIssue {
  path: string
  message: string
}

export type TurnRecordValidationResult =
  | { ok: true; record: AgentTurnRecord }
  | { ok: false; issues: TurnRecordValidationIssue[] }

export function validateAgentTurnRecord(value: unknown): TurnRecordValidationResult {
  const issues: TurnRecordValidationIssue[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] }
  const raw = value as Record<string, unknown>
  const require = (condition: boolean, path: string, message: string): void => { if (!condition) issues.push({ path, message }) }
  require(raw.schemaVersion === 1, '$.schemaVersion', 'unsupported schema version')
  require(raw.recordKind === 'agent_turn', '$.recordKind', 'must be agent_turn')
  require(Number.isSafeInteger(raw.sequence) && Number(raw.sequence) >= 1, '$.sequence', 'must be a positive safe integer')
  require(typeof raw.recordId === 'string' && raw.recordId.length > 0, '$.recordId', 'must be a non-empty string')
  require(typeof raw.recorderVersion === 'string' && raw.recorderVersion.length > 0, '$.recorderVersion', 'must be a non-empty string')
  require(typeof raw.sessionId === 'string' && raw.sessionId.length > 0, '$.sessionId', 'must be a non-empty string')
  require(isOptionalString(raw.providerTurnId), '$.providerTurnId', 'must be a string when present')
  require(raw.linkedTaskId === undefined || raw.linkedTaskId === null ||
    (typeof raw.linkedTaskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(raw.linkedTaskId)),
  '$.linkedTaskId', 'must be a bounded task ID or explicit null')
  require(raw.linkedTaskGeneration === undefined || (typeof raw.linkedTaskGeneration === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(raw.linkedTaskGeneration) && typeof raw.linkedTaskId === 'string'),
  '$.linkedTaskGeneration', 'requires a bound task and bounded generation')
  if (raw.taskLinkStatus !== undefined) require(
    (raw.taskLinkStatus === 'bound' && typeof raw.linkedTaskId === 'string' && typeof raw.linkedTaskGeneration === 'string') ||
    (['unbound', 'conflict'].includes(String(raw.taskLinkStatus)) && raw.linkedTaskId === null && raw.linkedTaskGeneration === undefined),
  '$.taskLinkStatus', 'must match the explicit task association')
  require(Number.isSafeInteger(raw.generation) && Number(raw.generation) >= 1, '$.generation', 'must be a positive safe integer')
  require(Number.isSafeInteger(raw.turnIndex) && Number(raw.turnIndex) >= 1, '$.turnIndex', 'must be a positive safe integer')
  require(isDateString(raw.startedAt), '$.startedAt', 'must be a valid timestamp')
  require(isDateString(raw.completedAt), '$.completedAt', 'must be a valid timestamp')
  if (isDateString(raw.startedAt) && isDateString(raw.completedAt)) require(Date.parse(raw.completedAt) >= Date.parse(raw.startedAt), '$.completedAt', 'must not precede startedAt')
  require(isNonNegativeNumber(raw.durationMs), '$.durationMs', 'must be finite and non-negative')
  require(['completed', 'failed', 'cancelled', 'interrupted'].includes(String(raw.status)), '$.status', 'invalid turn status')
  const workspace = raw.workspace as Record<string, unknown> | undefined
  require(!!workspace && typeof workspace.id === 'string' && workspace.id.length > 0 && typeof workspace.root === 'string' && workspace.root.length > 0, '$.workspace', 'invalid workspace identity')
  const provider = raw.provider as Record<string, unknown> | undefined
  require(!!provider && ['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(String(provider.id)) && isOptionalString(provider.version) && isOptionalString(provider.model), '$.provider', 'invalid provider identity')
  if (provider?.modelStatus !== undefined) require(
    (provider.modelStatus === 'observed' && typeof provider.model === 'string' && provider.model.length > 0 &&
      ['provider_model_event', 'usage_event'].includes(String(provider.modelSource)) &&
      provider.modelOmissionReason === undefined) ||
    (['unobserved', 'incomplete', 'conflict'].includes(String(provider.modelStatus)) &&
      provider.model === undefined && provider.modelSource === undefined &&
      typeof provider.modelOmissionReason === 'string' && provider.modelOmissionReason.length > 0),
  '$.provider.modelStatus', 'must match the observed model and carry a reason when absent')
  require(provider?.modelSource === undefined || provider.modelStatus !== undefined,
    '$.provider.modelSource', 'requires an explicit model status')
  if (raw.turnRoleStatus !== undefined) require(
    (raw.turnRoleStatus === 'observed' && isTurnRole(raw.turnRole)) ||
    (['unobserved', 'conflict'].includes(String(raw.turnRoleStatus)) && raw.turnRole === undefined),
  '$.turnRoleStatus', 'must match the structurally observed turn role')
  require(raw.turnRole === undefined || raw.turnRoleStatus === 'observed',
    '$.turnRole', 'requires an observed turn role status')

  const sections: Array<[string, (payload: unknown) => boolean, boolean?]> = [
    ['user', isTextPayload], ['assistant', isTextPayload],
    ['tools', (payload) => isArrayOf(payload, isTurnCall)],
    ['skills', (payload) => isArrayOf(payload, isTurnCall)],
    ['mcps', (payload) => isArrayOf(payload, isTurnCall)],
    ['hooks', (payload) => isArrayOf(payload, isTurnHook)],
    ['usage', isTurnUsage],
    ['files', (payload) => isArrayOf(payload, isTurnFile)],
    ['diff', (payload) => isArrayOf(payload, isTurnDiff), true],
    ['dangerousOperations', (payload) => isArrayOf(payload, isTurnDanger)],
    ['errors', (payload) => isArrayOf(payload, isTurnError)]
  ]
  for (const [section, validate, allowUnavailableValue] of sections) {
    require(isEvidencePayload(raw[section], validate, allowUnavailableValue), `$.${section}`, 'invalid evidence envelope or payload')
  }
  const usage = raw.usage as Evidence<TurnUsage> | undefined
  if (usage?.value?.credits !== undefined) require(provider?.id === 'qoder', '$.usage.value.credits', 'Qoder credits require Qoder provider identity')
  if (raw.compactions !== undefined) require(isCompactionsEvidence(raw.compactions), '$.compactions', 'invalid compaction evidence')
  if (raw.modelSegments !== undefined) require(isModelSegmentsEvidence(raw.modelSegments), '$.modelSegments', 'invalid model segment evidence')
  if (raw.modelTiming !== undefined) require(isModelTimingEvidence(raw.modelTiming), '$.modelTiming', 'invalid model timing evidence')
  if (raw.interventions !== undefined) require(isEvidencePayload(raw.interventions, (payload) => isArrayOf(payload, isIntervention)), '$.interventions', 'invalid intervention evidence')
  if (raw.termination !== undefined) require(isEvidencePayload(raw.termination, isTurnTermination), '$.termination', 'invalid termination evidence')
  return issues.length > 0 ? { ok: false, issues } : { ok: true, record: raw as unknown as AgentTurnRecord }
}

export function isAgentTurnRecord(value: unknown): value is AgentTurnRecord {
  return validateAgentTurnRecord(value).ok
}
