import { type TurnRepositoryDiscovery, type Evidence, type TurnModelTimingLane, type TurnModelCallTiming, type TurnModelTiming, type TurnModelSegment, type TurnTranscriptSource, type TurnCompaction } from './turn-record-contracts.js'
import { isToolContentRef } from './tool-content.js'
import { WRITABLE_OMISSION_CODES } from './turn-record-contracts.js'

/**
 * Readers accept a bounded list of codes without checking it against this build's enum: a record
 * written by a newer recorder is evidence, not a parse error, and rejecting the whole record throws
 * away every other section with it.
 */
const OMISSION_CODE_LIMIT = 16

/**
 * Every record position that carries an evidence envelope, in the order `validateAgentTurnRecord`
 * checks them. Codes live only inside these envelopes, so the write guard walks exactly this list
 * instead of the whole record: bounded by construction, with no depth or node budget that could stop
 * early and silently pass a code it never reached.
 */
export const EVIDENCE_SECTIONS = [
  'user', 'assistant', 'tools', 'skills', 'mcps', 'hooks', 'usage', 'files', 'diff',
  'dangerousOperations', 'errors', 'compactions', 'modelSegments', 'modelTiming',
  'transcript', 'interventions', 'termination'
] as const

/**
 * Write-side guard for the commit funnel. Section builders are typed with `OmissionCode`, which also
 * covers codes this build must not write yet, and a record can reach `commitRecord` as parsed JSON
 * (managed handoff). Returns every code outside `WRITABLE_OMISSION_CODES`; a non-empty result refuses
 * the commit. Misplaced code lists (not directly on an evidence envelope) are left to the validator.
 */
export function unwritableOmissionCodes(record: unknown): string[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return []
  const raw = record as Record<string, unknown>
  const found = new Set<string>()
  for (const section of EVIDENCE_SECTIONS) {
    const envelope = raw[section]
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue
    const codes = (envelope as Record<string, unknown>).omissionCodes
    if (!Array.isArray(codes)) continue
    for (const code of codes) {
      if (typeof code !== 'string' || !(WRITABLE_OMISSION_CODES as readonly string[]).includes(code)) found.add(String(code))
    }
  }
  return [...found]
}

export function isEvidence(value: unknown): value is Evidence<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!['available', 'partial', 'disabled', 'unavailable'].includes(String(raw.status))) return false
  if (!['exact', 'estimated', 'inferred', 'unavailable'].includes(String(raw.quality))) return false
  if (!Array.isArray(raw.source) || !raw.source.every((source) => typeof source === 'string' && source.length > 0)) return false
  if (raw.omissionReason !== undefined && (typeof raw.omissionReason !== 'string' || raw.omissionReason.length === 0)) return false
  if (raw.omissionCodes !== undefined && (!Array.isArray(raw.omissionCodes) ||
      raw.omissionCodes.length === 0 || raw.omissionCodes.length > OMISSION_CODE_LIMIT ||
      new Set(raw.omissionCodes).size !== raw.omissionCodes.length ||
      !raw.omissionCodes.every((code) => typeof code === 'string' && code.length > 0))) return false
  if (raw.status === 'available') return raw.value !== undefined && raw.quality !== 'unavailable' && raw.source.length > 0
  if (raw.status === 'partial') return raw.value !== undefined && raw.quality !== 'unavailable' && typeof raw.omissionReason === 'string' && raw.source.length > 0
  // Early schema-v1 writers omitted omissionReason, so readers retain that historical compatibility.
  return raw.quality === 'unavailable'
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isModelTimingLane(value: unknown): value is TurnModelTimingLane {
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

export function isModelTimingCall(value: unknown): value is TurnModelCallTiming {
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

export function isActivityCoverage(value: unknown): value is TurnModelTiming['activityCoverage'] {
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

export function isModelTiming(value: unknown): value is TurnModelTiming {
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

export function isModelTimingEvidence(value: unknown): value is Evidence<TurnModelTiming> {
  if (!isEvidence(value)) return false
  const raw = value as Evidence<unknown>
  if (raw.status === 'available' || raw.status === 'partial') return isModelTiming(raw.value)
  return raw.value === undefined || isModelTiming(raw.value)
}

export function isModelSegment(value: unknown): value is TurnModelSegment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    Number.isSafeInteger(raw.order) &&
    Number(raw.order) >= 0 &&
    isDateString(raw.at) &&
    (raw.kind === 'text' || raw.kind === 'thinking') &&
    typeof raw.text === 'string' &&
    raw.text.length > 0 &&
    (raw.contentRefs === undefined || Array.isArray(raw.contentRefs) && raw.contentRefs.length > 0 && raw.contentRefs.every(isToolContentRef)) &&
    (raw.messageId === undefined || typeof raw.messageId === 'string') &&
    (raw.providerItemId === undefined || typeof raw.providerItemId === 'string') &&
    (raw.parentId === undefined || typeof raw.parentId === 'string') &&
    (raw.agentId === undefined || typeof raw.agentId === 'string')
  )
}

export function isTurnTranscriptSource(value: unknown): value is TurnTranscriptSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  const identity = raw.identity as Record<string, unknown> | undefined
  return isToolContentRef(raw.contentRef) && typeof raw.sourcePath === 'string' && raw.sourcePath.length > 0 &&
    Number.isSafeInteger(raw.startOffset) && Number(raw.startOffset) >= 0 &&
    Number.isSafeInteger(raw.endOffset) && Number(raw.endOffset) >= Number(raw.startOffset) &&
    !!identity && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) =>
      typeof identity[key] === 'number' && Number.isFinite(identity[key])) &&
    Number(identity.size) >= Number(raw.endOffset) &&
    (raw.sourceCompleteness === 'complete' || raw.sourceCompleteness === 'partial')
}

export function isModelSegmentsEvidence(value: unknown): value is Evidence<TurnModelSegment[]> {
  if (!isEvidence(value)) return false
  const raw = value as Evidence<unknown>
  if (raw.value === undefined) return raw.status !== 'available' && raw.status !== 'partial'
  return Array.isArray(raw.value) && raw.value.every(isModelSegment)
}

export function isCompaction(value: unknown): value is TurnCompaction {
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

export function isCompactionsEvidence(value: unknown): value is Evidence<TurnCompaction[]> {
  if (!isEvidence(value)) return false
  const raw = value as Evidence<unknown>
  if (raw.value === undefined) return raw.status !== 'available' && raw.status !== 'partial'
  return Array.isArray(raw.value) && raw.value.every(isCompaction)
}

export function isDateString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

export function isTurnRepositoryDiscovery(value: unknown): value is TurnRepositoryDiscovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  const worktree = raw.worktreeDiscovery
  const validWorktree = worktree === undefined || (
    !!worktree && typeof worktree === 'object' && !Array.isArray(worktree) &&
    Number.isSafeInteger((worktree as Record<string, unknown>).probedRepositories) && Number((worktree as Record<string, unknown>).probedRepositories) >= 0 &&
    Number.isSafeInteger((worktree as Record<string, unknown>).skippedRepositories) && Number((worktree as Record<string, unknown>).skippedRepositories) >= 0 &&
    Number.isSafeInteger((worktree as Record<string, unknown>).discoveredWorktrees) && Number((worktree as Record<string, unknown>).discoveredWorktrees) >= 0 &&
    (worktree as Record<string, unknown>).incomplete === true
  )
  return Number.isSafeInteger(raw.maxDepth) && Number(raw.maxDepth) >= 0 &&
    Number.isSafeInteger(raw.depthLimitedDirectories) && Number(raw.depthLimitedDirectories) >= 0 &&
    validWorktree &&
    Array.isArray(raw.requestedRoots) && raw.requestedRoots.every(root => typeof root === 'string' && root.length > 0) &&
    new Set(raw.requestedRoots).size === raw.requestedRoots.length
}
