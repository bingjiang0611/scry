import type { AgentTurnRecord, Evidence, EvidenceQuality, OmissionCode } from './turn-record-contracts.js'

export { validateAgentTurnRecord, isAgentTurnRecord } from './turn-record-validate.js'
export { canonicalCostUsd } from './turn-record-contracts.js'
export type {
  EvidenceQuality,
  EvidenceStatus,
  Evidence,
  TurnCallStatus,
  TurnCall,
  TurnHookCall,
  TurnUsage,
  TurnModelTimingMethod,
  TurnModelCallTiming,
  TurnModelTimingLane,
  TurnModelTiming,
  TurnModelSegment,
  TurnTranscriptSource,
  TurnFile,
  TurnDiffSnapshotRecord,
  TurnDanger,
  TurnError,
  TurnCompaction,
  TurnSteerEvidence,
  TurnEvidence,
  TurnRepositoryDiscovery,
  AgentTurnRecord,
  TurnModelStatus,
  TurnModelSource,
  TurnRoleStatus,
  TurnRole,
  TurnEndReason,
  TurnCompletedAtSource,
  TurnTermination,
  TurnRecordValidationIssue,
  TurnRecordValidationResult
} from './turn-record-contracts.js'

export const REQUIRED_EVIDENCE_SECTIONS = [
  'user', 'assistant', 'tools', 'skills', 'mcps', 'hooks', 'usage', 'files', 'diff',
  'dangerousOperations', 'errors'
] as const

export const OPTIONAL_EVIDENCE_SECTIONS = ['interventions', 'compactions', 'modelSegments', 'modelTiming', 'transcript', 'termination'] as const

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

/**
 * Fixed wording for a usage section nobody can attribute. Records carry this sentence instead of an
 * `omissionCode` until servers and older readers accept codes other than the diff set; keep it stable
 * so a later version can recognise it, and match on this constant rather than on a copy of the text.
 */
export const USAGE_BASELINE_MISSING_REASON =
  "the provider reported cumulative usage but nothing proves the session counters before this turn, so this turn's usage is unknown"

export function unavailable<T>(reason: string, source: string[] = []): Evidence<T> {
  return { status: 'unavailable', quality: 'unavailable', source, omissionReason: reason }
}

export function disabled<T>(reason: string): Evidence<T> {
  return { status: 'disabled', quality: 'unavailable', source: ['config'], omissionReason: reason }
}

export function partial<T>(
  value: T,
  source: string[],
  reason: string,
  quality: EvidenceQuality = 'inferred',
  codes: OmissionCode[] = []
): Evidence<T> {
  return {
    status: 'partial',
    quality,
    source,
    value,
    omissionReason: reason,
    ...(codes.length > 0 ? { omissionCodes: [...new Set(codes)] } : {})
  }
}
