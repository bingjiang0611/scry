import { createHash } from 'node:crypto'
import { isToolContent, type ToolContent, type ToolContentRef } from '../../shared/tool-content.js'
import { type ToolContentPolicy, isFullToolContentPolicy, captureToolContent } from './tool-content.js'
import { type ProviderId } from '../../shared/provider.js'
import { type AgentTurnRecord, type Evidence, type EvidenceQuality, type EvidenceStatus, type TurnCall, type TurnTermination, type TurnEvidence } from '../../shared/turn-record.js'
import { readRecorderContent, writeRecorderContent } from './content-store.js'
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
      // A body this recorder could not prove is already marked unavailable; the record states the
      // omission instead of presenting a claim the evidence cannot support.
      if (isDegradedContent(field)) continue
      if (!isToolContent(field)) throw new Error('full managed evidence requires content provenance')
      if (field.content !== undefined) {
        const checked = captureToolContent(field.content, { source: field.source, maxBytes: policy.toolContentFieldBytes })
        if (checked.content !== field.content) throw new Error('managed content was not protected before canonical handoff')
      }
      bytes += field.savedBytes
    }
    if (isDegradedContent(call.outputContent)) continue
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

/**
 * 记录必须能自我兑现：写进 `.scry/records` 的每个引用都要在本工作区 recorder 内容库里存在字节，
 * 而正文保留多少由工作区采集策略决定（工具入参始终保留，工具输出按 toolOutput 裁剪）。缺失的正文
 * 降级为 unavailable 并让所在分区标 partial，绝不保留悬空引用，也不把缺失写成空内容或抛错。
 */
export const CONTENT_MISSING_REASON = 'complete body missing from workspace recorder content store'

export function isDegradedContent(field: ToolContent | undefined): boolean {
  return field !== undefined && field.storage === 'omitted' &&
    field.sourceCompleteness === 'unavailable' && field.contentRef === undefined
}

function unavailableContent(field: ToolContent): ToolContent {
  const { content: _content, contentRef: _contentRef, ...rest } = field
  return {
    ...rest,
    savedBytes: 0,
    storage: 'omitted',
    sourceCompleteness: 'unavailable',
    reasons: [...new Set([...rest.reasons, 'not_collected' as const])]
  }
}

function degradedSection<T extends { status: EvidenceStatus; quality: EvidenceQuality; omissionReason?: string }>(
  section: T,
  reason: string
): T {
  return {
    ...section,
    status: section.status === 'unavailable' ? 'unavailable' : 'partial',
    quality: section.quality === 'exact' ? 'inferred' : section.quality,
    omissionReason: [...new Set([...(section.omissionReason ? section.omissionReason.split('; ') : []), reason])].join('; ')
  }
}

export interface CaptureTrim {
  /** Tool output bodies are a promise of the full policy only; summary keeps the bounded summary. */
  keepToolOutputBody: boolean
}

export async function applyCapturePolicy(
  evidence: TurnEvidence,
  dataRoot: string,
  trim: CaptureTrim
): Promise<TurnEvidence> {
  const keepsOutputBody = trim.keepToolOutputBody
  const hasBody = async (ref: ToolContentRef): Promise<boolean> => {
    try {
      await readRecorderContent(dataRoot, ref)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  // A kept body must be durable here: persist the inline copy when the reference has no bytes, and
  // degrade only when this recorder cannot prove it holds the whole body. A truncated projection is
  // never promoted to a reference, because the reference would then claim more than its bytes.
  const durable = async (value: ToolContent | undefined): Promise<{ value?: ToolContent; lost: boolean }> => {
    if (!value) return { lost: false }
    if (value.contentRef && await hasBody(value.contentRef)) return { value, lost: false }
    if (value.storage !== 'complete' || value.content === undefined) {
      return { value: unavailableContent(value), lost: true }
    }
    const contentRef = await writeRecorderContent(dataRoot, value.content, value.encoding === 'json' ? 'json' : 'utf8')
    return { value: { ...value, contentRef }, lost: false }
  }

  const calls = async (section: Evidence<TurnCall[]>): Promise<Evidence<TurnCall[]>> => {
    if (!section.value) return section
    let lost = false
    const value = await Promise.all(section.value.map(async (call): Promise<TurnCall> => {
      const input = await durable(call.inputContent)
      lost ||= input.lost
      const kept: TurnCall = { ...call, ...(input.value ? { inputContent: input.value } : {}) }
      if (!keepsOutputBody) {
        // summary/none: the record keeps the bounded summary only. The body and its reference stay
        // in the App trace store, so the workspace store never receives the full tool output.
        const { outputContent: _dropped, ...summaryOnly } = kept
        return summaryOnly
      }
      const output = await durable(kept.outputContent)
      if (!output.lost) return { ...kept, ...(output.value ? { outputContent: output.value } : {}) }
      lost = true
      // The body is gone: the summary and error it produced cannot outlive it, and 'tool failed'
      // is the only claim the remaining evidence still supports.
      return {
        ...kept,
        outputContent: output.value!,
        outputSummary: undefined,
        ...(call.error !== undefined ? { error: 'tool failed' } : {})
      }
    }))
    return lost ? degradedSection({ ...section, value }, CONTENT_MISSING_REASON) : { ...section, value }
  }

  const refs = async (value: ToolContentRef[] | undefined): Promise<ToolContentRef[] | undefined> => {
    if (!value?.length) return value
    const kept = await Promise.all(value.map(hasBody))
    return kept.every(Boolean) ? value : undefined
  }

  const assistantRefs = await refs(evidence.assistant.value?.contentRefs)
  const assistant = evidence.assistant.value?.contentRefs && !assistantRefs
    ? {
      ...evidence.assistant,
      value: { ...evidence.assistant.value, contentRefs: undefined },
      // The bounded text projection stays, but the complete body is gone: the section says so and
      // is never re-labelled exact.
      status: 'partial' as const,
      quality: 'inferred' as const,
      omissionReason: CONTENT_MISSING_REASON
    }
    : evidence.assistant

  let segmentLoss = false
  const modelSegments = evidence.modelSegments?.value
    ? await Promise.all(evidence.modelSegments.value.map(async (segment) => {
      const kept = await refs(segment.contentRefs)
      if (segment.contentRefs && !kept) segmentLoss = true
      return kept ? segment : { ...segment, contentRefs: undefined }
    }))
    : undefined

  let patchLoss = false
  const diffValue = evidence.diff.value
    ? await Promise.all(evidence.diff.value.map(async (snapshot) => ({
      ...snapshot,
      files: await Promise.all(snapshot.files.map(async (file) => {
        const patch = await durable(file.patchContent)
        patchLoss ||= patch.lost
        return { ...file, ...(patch.value ? { patchContent: patch.value } : {}) }
      }))
    })))
    : undefined

  const transcriptDurable = evidence.transcript?.value ? await hasBody(evidence.transcript.value.contentRef) : true
  const [tools, skills, mcps] = await Promise.all([calls(evidence.tools), calls(evidence.skills), calls(evidence.mcps)])
  return {
    ...evidence,
    assistant,
    tools,
    skills,
    mcps,
    diff: patchLoss
      ? degradedSection({ ...evidence.diff, ...(diffValue ? { value: diffValue } : {}) }, CONTENT_MISSING_REASON)
      : { ...evidence.diff, ...(diffValue ? { value: diffValue } : {}) },
    ...(modelSegments
      ? { modelSegments: segmentLoss
        ? degradedSection({ ...evidence.modelSegments!, value: modelSegments }, CONTENT_MISSING_REASON)
        : { ...evidence.modelSegments!, value: modelSegments } }
      : {}),
    ...(evidence.transcript
      ? { transcript: transcriptDurable ? evidence.transcript : {
        ...evidence.transcript,
        value: undefined,
        status: 'unavailable' as const,
        quality: 'unavailable' as const,
        omissionReason: CONTENT_MISSING_REASON
      } }
      : {})
  }
}
