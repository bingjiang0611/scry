import type { ProviderId } from './provider.js'
import type { CompactionTrigger, DangerLevel, DiffFile, TurnDiffCollection, TurnDiffReason, TurnDiffStatus } from './trace.js'
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
  provider: { id: ProviderId; version?: string; model?: string }
  sessionId: string
  providerTurnId?: string
  generation: number
  turnIndex: number
  startedAt: string
  completedAt: string
  durationMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
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
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return (
    ['available', 'partial', 'disabled', 'unavailable'].includes(String(raw.status)) &&
    ['exact', 'estimated', 'inferred', 'unavailable'].includes(String(raw.quality)) &&
    Array.isArray(raw.source)
  )
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isModelTimingLane(value: unknown): value is TurnModelTimingLane {
  if (!value || typeof value !== 'object') return false
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
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return (
    ['root', 'subagent'].includes(String(raw.scope)) &&
    typeof raw.completedAt === 'string' &&
    ['provider', 'observed'].includes(String(raw.source)) &&
    (raw.durationMs === undefined || isNonNegativeNumber(raw.durationMs)) &&
    (raw.boundary === undefined || raw.boundary === 'turn_or_activity_end')
  )
}

function isActivityCoverage(value: unknown): value is TurnModelTiming['activityCoverage'] {
  if (!value || typeof value !== 'object') return false
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
  if (!value || typeof value !== 'object') return false
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
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return (
    Number.isSafeInteger(raw.order) &&
    Number(raw.order) >= 0 &&
    typeof raw.at === 'string' &&
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
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.eventId === 'string' &&
    raw.eventId.length > 0 &&
    typeof raw.at === 'string' &&
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

export function isAgentTurnRecord(value: unknown): value is AgentTurnRecord {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || raw.recordKind !== 'agent_turn') return false
  if (!Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1) return false
  if (typeof raw.recordId !== 'string' || !raw.recordId) return false
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return false
  if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1) return false
  if (!Number.isSafeInteger(raw.turnIndex) || Number(raw.turnIndex) < 1) return false
  if (typeof raw.startedAt !== 'string' || typeof raw.completedAt !== 'string') return false
  if (!raw.workspace || typeof raw.workspace !== 'object' || !raw.provider || typeof raw.provider !== 'object') return false
  const provider = raw.provider as Record<string, unknown>
  if (!['claude', 'codex', 'qoder', 'opencode'].includes(String(provider.id))) return false
  const requiredEvidence = [
    'user',
    'assistant',
    'tools',
    'skills',
    'mcps',
    'hooks',
    'usage',
    'files',
    'diff',
    'dangerousOperations',
    'errors'
  ].every((key) => isEvidence(raw[key]))
  return requiredEvidence &&
    (raw.compactions === undefined || isCompactionsEvidence(raw.compactions)) &&
    (raw.modelSegments === undefined || isModelSegmentsEvidence(raw.modelSegments)) &&
    (raw.modelTiming === undefined || isModelTimingEvidence(raw.modelTiming)) &&
    (raw.interventions === undefined || isEvidence(raw.interventions))
}
