import { isTurnRepositoryDiscovery, isDateString, isEvidence, isOptionalString, isNonNegativeNumber, isCompactionsEvidence, isModelSegmentsEvidence, isModelTimingEvidence, isTurnTranscriptSource } from './turn-evidence-validation.js'
import type { AgentTurnRecord, Evidence, EvidenceQuality, TurnCall, TurnHookCall, TurnUsage, TurnFile, TurnDiffSnapshotRecord, TurnDanger, TurnRole, TurnError, TurnRecordValidationResult, TurnRecordValidationIssue } from './turn-record-contracts.js'
import { isToolContentRef, isToolContent } from './tool-content.js'
import { isSupportedImageMimeType } from './runtime.js'
import { isCreditUsageEvidence, creditSourcesMatchProvider } from './credit-usage.js'
import { normalizeTurnDiffSnapshot } from './trace.js'
import { isIntervention } from './turn-intervention-validation.js'

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

const DECIMAL_20_8_LIMIT = 1_000_000_000_000

export function canonicalCostUsd(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0 || value >= DECIMAL_20_8_LIMIT) return undefined
  const rounded = Number(value.toFixed(8))
  if (!Number.isFinite(rounded) || rounded >= DECIMAL_20_8_LIMIT) return undefined
  return Object.is(rounded, -0) ? 0 : rounded
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

export const OPTIONAL_EVIDENCE_SECTIONS = ['interventions', 'compactions', 'modelSegments', 'modelTiming', 'transcript', 'termination'] as const

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

function isEvidencePayload(value: unknown, validate: (payload: unknown) => boolean, allowUnavailableValue = false): boolean {
  if (!isEvidence(value)) return false
  const evidence = value as Evidence<unknown>
  if (evidence.status === 'available' || evidence.status === 'partial') return validate(evidence.value)
  return evidence.value === undefined || (allowUnavailableValue && validate(evidence.value))
}

function isTextPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return isOptionalString(raw.text) && isOptionalString(raw.textHash) &&
    (raw.contentRefs === undefined || Array.isArray(raw.contentRefs) && raw.contentRefs.length > 0 && raw.contentRefs.every(isToolContentRef))
}

function isUserTextPayload(value: unknown): boolean {
  if (!isTextPayload(value)) return false
  const raw = value as Record<string, unknown>
  if (raw.steers === undefined) return true
  return Array.isArray(raw.steers) && raw.steers.every(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const steer = value as Record<string, unknown>
    return typeof steer.messageId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(steer.messageId) &&
      typeof steer.prompt === 'string' && typeof steer.status === 'string' && ['pending', 'accepted', 'rejected', 'unavailable', 'unknown'].includes(steer.status) &&
      isOptionalString(steer.message) && isOptionalString(steer.providerTurnId) &&
      Array.isArray(steer.attachments) && steer.attachments.every(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false
        const attachment = value as Record<string, unknown>
        return typeof attachment.name === 'string' && typeof attachment.mimeType === 'string' && isSupportedImageMimeType(attachment.mimeType) &&
          Number.isSafeInteger(attachment.size) && Number(attachment.size) >= 0 &&
          typeof attachment.sha256 === 'string' && /^sha256:[0-9a-f]{64}$/.test(attachment.sha256)
      })
  })
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

function isArrayOf(value: unknown, validate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(validate)
}

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
    ['user', isUserTextPayload], ['assistant', isTextPayload],
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
  if (isEvidence(raw.diff) && 'discovery' in raw.diff && raw.diff.discovery !== undefined) {
    require(isTurnRepositoryDiscovery(raw.diff.discovery), '$.diff.discovery', 'invalid repository discovery metadata')
  }
  const usage = raw.usage as Evidence<TurnUsage> | undefined
  if (usage?.value?.credits !== undefined) require(creditSourcesMatchProvider(provider?.id, usage.value.credits.source), '$.usage.value.credits', 'credits require a source matching the agent provider')
  if (raw.compactions !== undefined) require(isCompactionsEvidence(raw.compactions), '$.compactions', 'invalid compaction evidence')
  if (raw.modelSegments !== undefined) require(isModelSegmentsEvidence(raw.modelSegments), '$.modelSegments', 'invalid model segment evidence')
  if (raw.modelTiming !== undefined) require(isModelTimingEvidence(raw.modelTiming), '$.modelTiming', 'invalid model timing evidence')
  if (raw.transcript !== undefined) require(isEvidencePayload(raw.transcript, isTurnTranscriptSource), '$.transcript', 'invalid transcript evidence')
  if (raw.interventions !== undefined) require(isEvidencePayload(raw.interventions, (payload) => isArrayOf(payload, isIntervention)), '$.interventions', 'invalid intervention evidence')
  if (raw.termination !== undefined) require(isEvidencePayload(raw.termination, isTurnTermination), '$.termination', 'invalid termination evidence')
  return issues.length > 0 ? { ok: false, issues } : { ok: true, record: raw as unknown as AgentTurnRecord }
}

export function isAgentTurnRecord(value: unknown): value is AgentTurnRecord {
  return validateAgentTurnRecord(value).ok
}
