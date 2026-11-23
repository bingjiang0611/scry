import type { Evidence, EvidenceQuality } from '../../shared/turn-record-contracts'
import type { TurnAuthor } from './types'

export const TASK_SUMMARY_MAX_BYTES = 2048

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let end = text.length
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end = Math.floor(end * 0.9)
  }
  while (end < text.length && Buffer.byteLength(text.slice(0, end + 1), 'utf8') <= maxBytes) {
    end += 1
  }
  return { text: text.slice(0, end), truncated: true }
}

/**
 * Builds the task summary Evidence (P6 evidence §E1):
 * - Inherits archive status and quality verbatim (never promotes inferred/partial to exact/available).
 * - Truncates to 2 KiB with status='partial' while keeping quality unchanged.
 * - Empty or missing final message becomes unavailable(empty_final_message).
 */
export function buildTaskSummaryEvidence(
  archiveFinalMessage: Evidence<string> | null | undefined,
  missingReason = 'archive_unavailable'
): Evidence<string> {
  if (!archiveFinalMessage) {
    return {
      status: 'unavailable',
      quality: 'unavailable',
      source: ['trace-archive'],
      omissionReason: missingReason
    }
  }
  if (archiveFinalMessage.status === 'unavailable' || archiveFinalMessage.status === 'disabled') {
    return archiveFinalMessage
  }
  const raw = archiveFinalMessage.value
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      status: 'unavailable',
      quality: 'unavailable',
      source: archiveFinalMessage.source,
      omissionReason: 'empty_final_message'
    }
  }
  const { text, truncated } = truncateUtf8(raw, TASK_SUMMARY_MAX_BYTES)
  return {
    status: truncated ? 'partial' : archiveFinalMessage.status,
    quality: archiveFinalMessage.quality,
    source: archiveFinalMessage.source,
    value: text,
    ...(truncated ? { omissionReason: 'summary_truncated_2kib' } : {})
  }
}

export interface UserTurnCountResult {
  userTurns: number
  excludedAgentTurns: number
  unavailableAuthorTurns: number
  status: 'available' | 'partial'
}

/**
 * Counts user-authored turns by joining `orch_p_turn.author` (P6 evidence §E2 / D17):
 * excludes `author === 'agent'`; missing or `'unavailable'` authors mark the result `partial`.
 */
export function countUserTurnsWithAuthor(
  turns: ReadonlyArray<{ runId: string; author: TurnAuthor | null | undefined }>
): UserTurnCountResult {
  let userTurns = 0
  let excludedAgentTurns = 0
  let unavailableAuthorTurns = 0
  for (const turn of turns) {
    if (turn.author === 'user') userTurns += 1
    else if (turn.author === 'agent') excludedAgentTurns += 1
    else if (turn.author === 'system') continue
    else unavailableAuthorTurns += 1
  }
  return {
    userTurns,
    excludedAgentTurns,
    unavailableAuthorTurns,
    status: unavailableAuthorTurns > 0 ? 'partial' : 'available'
  }
}

export interface UsageMetricSample {
  status: 'available' | 'partial' | 'unavailable' | 'disabled'
  quality: EvidenceQuality
  value?: number
}

export interface ChildUsageSample {
  runId: string
  tokens?: UsageMetricSample
  usd?: UsageMetricSample
  credits?: UsageMetricSample
}

export type QualitySubtotals = Partial<Record<'exact' | 'estimated' | 'inferred', number>>

export interface DelegatedUsageSummary {
  status: 'available' | 'partial'
  unavailableCount: number
  tokens: QualitySubtotals
  usd: QualitySubtotals
  credits: QualitySubtotals
}

function addMetric(target: QualitySubtotals, sample: UsageMetricSample | undefined): boolean {
  if (!sample) return true
  if (sample.status === 'unavailable' || sample.status === 'disabled' || typeof sample.value !== 'number') {
    return false
  }
  if (sample.quality === 'exact' || sample.quality === 'estimated' || sample.quality === 'inferred') {
    target[sample.quality] = (target[sample.quality] ?? 0) + sample.value
  }
  return sample.status === 'available'
}

/**
 * Aggregates child run usage by unit and by quality in parallel (P6 evidence §E3):
 * never sums across units, never collapses exact/estimated/inferred into one quality,
 * and marks missing child usage as `partial` (never zero-filled).
 */
export function aggregateDelegatedUsage(samples: readonly ChildUsageSample[]): DelegatedUsageSummary {
  const tokens: QualitySubtotals = {}
  const usd: QualitySubtotals = {}
  const credits: QualitySubtotals = {}
  let unavailableCount = 0

  for (const sample of samples) {
    const tOk = addMetric(tokens, sample.tokens)
    const uOk = addMetric(usd, sample.usd)
    const cOk = addMetric(credits, sample.credits)
    const hasAnyMetric = Boolean(sample.tokens || sample.usd || sample.credits)
    if (!hasAnyMetric || !tOk || !uOk || !cOk) {
      unavailableCount += 1
    }
  }

  return {
    status: unavailableCount > 0 ? 'partial' : 'available',
    unavailableCount,
    tokens,
    usd,
    credits
  }
}

export interface RunInterval {
  runId: string
  cwd: string | null
  startedAt: number
  endedAt: number | null
}

export interface ParallelWorkspaceOverlapResult {
  overlapped: boolean
  overlappingRunIds: string[]
  attributionStatus: 'exact' | 'partial'
  attributionQuality: 'exact' | 'inferred'
  reason?: 'parallel_workspace_runs'
}

/**
 * Detects overlapping non-terminal intervals on the same canonical cwd (P6 evidence §E4).
 */
export function detectParallelWorkspaceOverlap(
  target: RunInterval,
  peers: readonly RunInterval[]
): ParallelWorkspaceOverlapResult {
  if (!target.cwd) {
    return { overlapped: false, overlappingRunIds: [], attributionStatus: 'exact', attributionQuality: 'exact' }
  }
  const tEnd = target.endedAt ?? Number.POSITIVE_INFINITY
  const overlappingRunIds: string[] = []
  for (const peer of peers) {
    if (peer.runId === target.runId || peer.cwd !== target.cwd) continue
    const pEnd = peer.endedAt ?? Number.POSITIVE_INFINITY
    if (target.startedAt <= pEnd && peer.startedAt <= tEnd) {
      overlappingRunIds.push(peer.runId)
    }
  }
  if (overlappingRunIds.length === 0) {
    return { overlapped: false, overlappingRunIds: [], attributionStatus: 'exact', attributionQuality: 'exact' }
  }
  return {
    overlapped: true,
    overlappingRunIds,
    attributionStatus: 'partial',
    attributionQuality: 'inferred',
    reason: 'parallel_workspace_runs'
  }
}
