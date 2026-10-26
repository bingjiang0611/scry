import { createHash } from 'node:crypto'
import { isToolContent } from '../../shared/tool-content.js'
import { type ToolContentPolicy, isFullToolContentPolicy, captureToolContent } from './tool-content.js'
import { type ProviderId } from '../../shared/provider.js'
import { type AgentTurnRecord, type Evidence, type TurnTermination, type TurnEvidence } from '../../shared/turn-record.js'
import { type RecorderEnablement } from './config.js'
import { type RecorderOpenTurnState } from './runtime-state.js'
import { stableHash, RECORDER_VERSION } from './store.js'


export interface ManagedTurnTiming {
  startedAt: string
  completedAt: string
  durationMs: number
}

export type ManagedRecorderProviderId = Extract<ProviderId, 'claude' | 'codex' | 'qoder' | 'opencode' | 'pi'>

const QODER_PROVISIONAL_START_TOLERANCE_MS = 5_000

export function isManagedRecorderProvider(provider: ProviderId): provider is ManagedRecorderProviderId {
  return provider === 'claude' || provider === 'codex' || provider === 'qoder' || provider === 'opencode' || provider === 'pi'
}

export function managedRecorderAllowsMissingProviderTurnId(
  provider: ManagedRecorderProviderId,
  status: AgentTurnRecord['status']
): boolean {
  return (provider === 'qoder' && status === 'interrupted') ||
    (provider === 'opencode' && (status === 'failed' || status === 'interrupted'))
}

export function isManagedProviderRuntimePair(provider: unknown, runtimeProvider: unknown): boolean {
  return (provider === 'claude' && runtimeProvider === 'claude_sdk') ||
    (provider === 'codex' && runtimeProvider === 'codex_cli') ||
    (provider === 'qoder' && runtimeProvider === 'qoder_cli') ||
    (provider === 'opencode' && runtimeProvider === 'opencode_server') ||
    (provider === 'pi' && runtimeProvider === 'pi_rpc')
}

export interface PrepareManagedTurnInput {
  /** Main is replaying a validated, terminal canonical journal after its provisional lifecycle was lost. */
  allowCanonicalJournalRecovery?: boolean
  /** Main proved the durable Qoder interruption trace contains only local launch/diff events. */
  allowObservedInterruption?: boolean
  /** How the App established this turn's end. Omitted by pre-0.2.38 callers. */
  termination?: Evidence<TurnTermination>
  toolContentPolicy?: ToolContentPolicy
  workspace: string
  provider: ManagedRecorderProviderId
  sessionId: string
  runId: string
  providerTurnId?: string
  userText: string
  evidence: TurnEvidence
  timing: ManagedTurnTiming
  status: AgentTurnRecord['status']
  archiveFingerprint: string
  expectedRecordId?: string
  env?: NodeJS.ProcessEnv
}

export type ManagedTurnResult =
  | { status: 'disabled'; reason: string }
  | { status: 'pending'; reason: string }
  | { status: 'prepared'; recordId: string }
  | { status: 'committed' | 'duplicate'; recordId: string; record: AgentTurnRecord }

export type ManagedTurnCancellationResult =
  | { status: 'disabled'; reason: string }
  | { status: 'not_found' }
  | { status: 'cancelled'; generation: number }

export interface ManagedTurnHandoff {
  uploadEnvironment?: import('./commit-environment.js').UploadEnvironment
  schemaVersion: 1
  phase: 'prepared' | 'archive_committed'
  runId: string
  archiveFingerprint: string
  preparedAt: string
  record: Omit<AgentTurnRecord, 'sequence'>
}

export type EnabledRecorder = Extract<RecorderEnablement, { enabled: true }>

function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

export function rawTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function managedProvisionalMatches(
  candidate: RecorderOpenTurnState,
  input: PrepareManagedTurnInput
): boolean {
  const inputPromptHash = rawTextHash(input.userText)
  if (candidate.managedRunId || candidate.managedPromptHash) {
    return candidate.managedRunId === input.runId && candidate.managedPromptHash === inputPromptHash
  }
  if (candidate.promptHash !== inputPromptHash) return false
  const opened = Date.parse(candidate.startedAt)
  const started = Date.parse(input.timing.startedAt)
  return Number.isFinite(opened) && Number.isFinite(started) &&
    Math.abs(opened - started) <= QODER_PROVISIONAL_START_TOLERANCE_MS
}

export function assertExactText(
  evidence: Evidence<{ text?: string; textHash?: string }>,
  expected: string | undefined,
  label: 'user' | 'assistant'
): void {
  const text = evidence.value?.text
  // An attachment-only user turn has an exact empty textual component. Assistant output must
  // remain non-empty, and an omitted user value must never be confused with an exact empty one.
  const emptyTextAllowed = label === 'user' && expected === ''
  if (
    evidence.status !== 'available' || evidence.quality !== 'exact' ||
    typeof text !== 'string' || (!emptyTextAllowed && text.length === 0)
  ) {
    throw new Error(`managed recorder requires ${emptyTextAllowed ? 'exact' : 'non-empty exact'} ${label} evidence`)
  }
  if (evidence.value?.textHash !== hashText(text)) {
    throw new Error(`managed recorder ${label} text hash mismatch`)
  }
  if (expected != null && text !== expected) {
    throw new Error(`managed recorder ${label} text differs from Scry input`)
  }
}

export function assertOptionalAssistantText(evidence: Evidence<{ text?: string; textHash?: string }>): void {
  const text = evidence.value?.text
  if (text && evidence.value?.textHash !== hashText(text)) {
    throw new Error('managed recorder assistant text hash mismatch')
  }
}

export function assertStrictCapture(enablement: EnabledRecorder): void {
  const capture = enablement.config.capture
  const missing = [
    !capture.prompt && 'prompt',
    !capture.assistant && 'assistant',
    capture.toolOutput === 'none' && 'toolOutput=summary|full',
    !capture.diff && 'diff',
    !capture.hooks && 'hooks'
  ].filter((value): value is string => !!value)
  if (missing.length) throw new Error(`managed recorder strict capture is disabled: ${missing.join(', ')}`)
}

export function assertProtectedToolEvidence(evidence: TurnEvidence, policy: ToolContentPolicy): void {
  if (!isFullToolContentPolicy(policy)) return
  let bytes = 0
  for (const call of [evidence.tools, evidence.skills, evidence.mcps].flatMap((section) => section.value ?? [])) {
    if (call.input !== undefined) throw new Error('full managed input requires bounded content envelopes')
    for (const field of [call.inputContent, call.outputContent]) {
      if (!isToolContent(field)) throw new Error('full managed evidence requires content provenance')
      if (field.content !== undefined) {
        const checked = captureToolContent(field.content, { source: field.source, maxBytes: policy.toolContentFieldBytes })
        if (checked.content !== field.content) throw new Error('managed content was not protected before canonical handoff')
      }
      bytes += field.savedBytes
    }
    const output = call.outputContent?.content
    const summary = output ? (output.length <= 500 ? output : `${output.slice(0, 500)}…`) : undefined
    if (call.outputSummary !== undefined && call.outputSummary !== summary) throw new Error('managed summary differs from protected output')
    if (call.error !== undefined && call.error !== summary && call.error !== 'tool failed') throw new Error('managed error differs from protected output')
  }
  if (bytes > (policy.toolContentTurnBytes ?? 128 * 1024)) throw new Error('managed tool content exceeds turn budget')
}

export function assertTiming(timing: ManagedTurnTiming): void {
  const started = Date.parse(timing.startedAt)
  const completed = Date.parse(timing.completedAt)
  if (!Number.isFinite(started) || !Number.isFinite(completed) || !Number.isFinite(timing.durationMs) || timing.durationMs < 0) {
    throw new Error('managed recorder requires exact result timing')
  }
  if (Math.max(0, completed - started) !== timing.durationMs) {
    throw new Error('managed recorder timing fields are inconsistent')
  }
}

export function recordDraft(
  enablement: EnabledRecorder,
  open: RecorderOpenTurnState,
  input: PrepareManagedTurnInput
): Omit<AgentTurnRecord, 'sequence'> {
  const recordId = stableHash({
    workspace: enablement.config.workspaceId,
    provider: open.provider,
    sessionId: open.sessionId,
    generation: open.generation,
    startedAt: open.startedAt
  }).slice(0, 32)
  return {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    recordId,
    recorderVersion: RECORDER_VERSION,
    workspace: { id: enablement.config.workspaceId, root: enablement.workspaceRoot },
    provider: {
      id: open.provider,
      ...(input.evidence.usage.value?.model ? { model: input.evidence.usage.value.model } : {})
    },
    sessionId: open.sessionId,
    ...(input.providerTurnId ? { providerTurnId: input.providerTurnId } : {}),
    generation: open.generation,
    turnIndex: open.turnIndex,
    ...input.timing,
    status: input.status,
    ...(input.termination ? { termination: input.termination } : {}),
    ...input.evidence
  }
}

function recordEvidence(record: AgentTurnRecord): TurnEvidence {
  return {
    user: record.user,
    assistant: record.assistant,
    tools: record.tools,
    skills: record.skills,
    mcps: record.mcps,
    hooks: record.hooks,
    usage: record.usage,
    ...(record.compactions ? { compactions: record.compactions } : {}),
    ...(record.modelSegments ? { modelSegments: record.modelSegments } : {}),
    ...(record.modelTiming ? { modelTiming: record.modelTiming } : {}),
    files: record.files,
    diff: record.diff,
    dangerousOperations: record.dangerousOperations,
    errors: record.errors,
    ...(record.interventions ? { interventions: record.interventions } : {})
  }
}

export function assertDuplicateMatchesInput(record: AgentTurnRecord, input: PrepareManagedTurnInput): void {
  if (
    record.provider.id !== input.provider ||
    record.sessionId !== input.sessionId ||
    record.providerTurnId !== input.providerTurnId ||
    record.startedAt !== input.timing.startedAt ||
    record.completedAt !== input.timing.completedAt ||
    record.durationMs !== input.timing.durationMs ||
    record.status !== input.status ||
    stableHash(recordEvidence(record)) !== stableHash(input.evidence)
  ) {
    throw new Error('managed recorder existing record differs from canonical Scry turn')
  }
}

export function assertCommittedRecordMatchesHandoff(
  record: AgentTurnRecord,
  handoff: ManagedTurnHandoff
): void {
  const { sequence: _sequence, ...draft } = record
  if (stableHash(draft) !== stableHash(handoff.record)) {
    throw new Error('managed recorder duplicate record differs from prepared canonical handoff')
  }
}
