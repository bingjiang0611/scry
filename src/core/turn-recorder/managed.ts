import { createHash } from 'node:crypto'
import { observedInterruptionRecordId, reserveObservedInterruption } from './managed-interruption.js'
import { isToolContent } from '../../shared/tool-content.js'
import { captureToolContent, isFullToolContentPolicy, type ToolContentPolicy } from './tool-content.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import {
  isAgentTurnRecord,
  type AgentTurnRecord,
  type Evidence,
  type TurnEvidence,
  type TurnTermination
} from '../../shared/turn-record.js'
import {
  resolveRecorderEnablement, type RecorderEnablement } from './config.js'
import { listFiles, readJson, writeJsonAtomic } from './io.js'
import {
  SESSION_LOCK_WAIT_MS,
  recorderOpenPath,
  recorderPendingHealth,
  recorderQuarantinedOpenTurns,
  withRecorderSessionLock,
  recorderSessionRoot,
  recorderStatePath,
  recorderTurnRoot,
  type RecorderOpenTurnState,
  type RecorderSessionState
} from './runtime-state.js'
import {
  HOOK_DRAIN_BUDGET_MS,
  HOOK_DRAIN_MAX_RECORDS,
  RECORDER_VERSION,
  clearRuntimeTurn,
  commitRecord,
  drainCommitNotifications,
  findRecordById,
  listRecords,
  recordStoreStamp,
  stableHash,
  updateHealth
} from './store.js'

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

interface ManagedTurnHandoff {
  schemaVersion: 1
  phase: 'prepared' | 'archive_committed'
  runId: string
  archiveFingerprint: string
  preparedAt: string
  record: Omit<AgentTurnRecord, 'sequence'>
}

type EnabledRecorder = Extract<RecorderEnablement, { enabled: true }>

function canonicalPath(root: string, generation: number): string {
  return join(recorderTurnRoot(root, generation), 'canonical.json')
}

function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

export async function cancelManagedRecorderTurn(input: {
  workspace: string
  provider: ManagedRecorderProviderId
  sessionId: string
  runId: string
  promptHash: string
  env?: NodeJS.ProcessEnv
}): Promise<ManagedTurnCancellationResult> {
  const mode = await managedRecorderMode(input.workspace, input.env)
  if (mode.status === 'disabled') return mode
  const { enablement } = mode
  const root = recorderSessionRoot(enablement.dataRoot, input.provider, input.sessionId)
  const result = await withRecorderSessionLock(
    enablement.dataRoot, input.provider, input.sessionId,
    async (): Promise<ManagedTurnCancellationResult> => {
      const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
      if (!open) return { status: 'not_found' }
      if (
        !open.managedByScry ||
        open.provider !== input.provider ||
        open.sessionId !== input.sessionId ||
        open.managedRunId !== input.runId ||
        open.managedPromptHash !== input.promptHash
      ) {
        throw new Error('managed recorder cancellation identity differs from the open lifecycle')
      }
      if (open.providerTurnId) {
        throw new Error('managed recorder cancellation refused after Provider turn identity was observed')
      }
      if (await readJson<ManagedTurnHandoff>(canonicalPath(root, open.generation))) {
        throw new Error('managed recorder cancellation refused after canonical handoff was prepared')
      }
      await rm(recorderOpenPath(root), { force: true })
      await clearRuntimeTurn(enablement.dataRoot, recorderTurnRoot(root, open.generation))
      return { status: 'cancelled', generation: open.generation }
    },
    { waitMs: SESSION_LOCK_WAIT_MS }
  )
  await updateHealth(enablement.dataRoot, {
    ...(await recorderPendingHealth(enablement.dataRoot)),
    lastSuccessAt: new Date().toISOString(),
    lastError: undefined
  })
  return result
}

function rawTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function managedProvisionalMatches(
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

function assertExactText(
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

function assertOptionalAssistantText(evidence: Evidence<{ text?: string; textHash?: string }>): void {
  const text = evidence.value?.text
  if (text && evidence.value?.textHash !== hashText(text)) {
    throw new Error('managed recorder assistant text hash mismatch')
  }
}

async function reserveCanonicalJournalRecovery(
  dataRoot: string,
  root: string,
  input: PrepareManagedTurnInput
): Promise<RecorderOpenTurnState | undefined> {
  const end = input.termination
  if (
    !input.allowCanonicalJournalRecovery || !input.providerTurnId || !input.runId ||
    (end?.status !== 'available' && end?.status !== 'partial') ||
    !end.value || end.value.observedAt !== input.timing.completedAt ||
    (end.value.completedAtSource !== 'provider_terminal_event' &&
      end.value.completedAtSource !== 'recorder_observed_terminal')
  ) return undefined

  // The canonical journal is written only after the Provider has terminated and contains the
  // authoritative provider turn id plus exact evidence. If a previous recovery removed the
  // provisional open before preparing its handoff, reserve a fresh durable generation instead of
  // leaving the journal in a permanent front-door deadlock.
  const state = await readJson<RecorderSessionState>(recorderStatePath(root))
  const records = (await listRecords(dataRoot)).filter((record) =>
    record.provider.id === input.provider && record.sessionId === input.sessionId)
  const reserved = (await listFiles(join(root, 'turns')))
    .filter((name) => /^\d+$/.test(name)).map(Number)
  const generation = Math.max(state?.lastGeneration ?? 0, ...records.map((record) => record.generation), ...reserved) + 1
  const turnIndex = Math.max(state?.lastTurnIndex ?? 0, ...records.map((record) => record.turnIndex)) + 1
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(turnIndex)) {
    throw new Error('managed recorder canonical journal recovery sequence is invalid')
  }
  const open: RecorderOpenTurnState = {
    schemaVersion: 1,
    provider: input.provider,
    sessionId: input.sessionId,
    generation,
    turnIndex,
    status: 'closing',
    startedAt: input.timing.startedAt,
    terminalAt: input.timing.completedAt,
    terminalAtSource: end.value.completedAtSource,
    terminalFallbackStatus: input.status,
    endReason: end.value.reason,
    prompt: input.userText,
    promptHash: rawTextHash(input.userText),
    providerTurnId: input.providerTurnId,
    managedByScry: true,
    managedRunId: input.runId,
    managedPromptHash: rawTextHash(input.userText),
    startFingerprint: stableHash({ source: 'canonical_journal_recovery', runId: input.runId, timing: input.timing }),
    captures: []
  }
  // Publish the recoverable open before advancing the cache. A crash between these writes leaves
  // an identity that the next replay can still finish; commitHandoff repairs both high-water marks.
  await writeJsonAtomic(recorderOpenPath(root), open)
  await writeJsonAtomic(recorderStatePath(root), {
    ...state,
    schemaVersion: 1,
    lastGeneration: generation,
    lastTurnIndex: turnIndex
  })
  return open
}

function assertStrictCapture(enablement: EnabledRecorder): void {
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

function assertProtectedToolEvidence(evidence: TurnEvidence, policy: ToolContentPolicy): void {
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

function assertTiming(timing: ManagedTurnTiming): void {
  const started = Date.parse(timing.startedAt)
  const completed = Date.parse(timing.completedAt)
  if (!Number.isFinite(started) || !Number.isFinite(completed) || !Number.isFinite(timing.durationMs) || timing.durationMs < 0) {
    throw new Error('managed recorder requires exact result timing')
  }
  if (Math.max(0, completed - started) !== timing.durationMs) {
    throw new Error('managed recorder timing fields are inconsistent')
  }
}

export async function managedRecorderMode(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ status: 'disabled'; reason: string } | { status: 'enabled'; enablement: EnabledRecorder }> {
  const enablement = await resolveRecorderEnablement(workspace, env)
  if (!enablement.enabled) {
    if (enablement.reason === 'invalid_config') {
      throw new Error(`managed recorder config is invalid${enablement.detail ? `: ${enablement.detail}` : ''}`)
    }
    return { status: 'disabled', reason: enablement.reason }
  }
  assertStrictCapture(enablement)
  return { status: 'enabled', enablement }
}

async function recordById(dataRoot: string, recordId: string): Promise<AgentTurnRecord | undefined> {
  return await findRecordById(dataRoot, recordId)
}

/**
 * 本 session 已提交 providerTurnId → recordId 的派生缓存（可从 records 完整重建，不是事实源）。
 * `stamp` 是建缓存时看到的存储指纹：只有指纹仍然一致才允许用它作否定判断。
 */
interface ManagedProviderTurnIndex {
  schemaVersion: 1
  stamp: { count: number; maxSequence: number }
  providerTurnRecordIds: Record<string, string>
}

function providerTurnIndexPath(root: string): string {
  return join(root, 'provider-turn-index.json')
}

async function readProviderTurnIndex(
  dataRoot: string,
  root: string
): Promise<{ stamp: { count: number; maxSequence: number }; index: ManagedProviderTurnIndex | null }> {
  const stamp = await recordStoreStamp(dataRoot)
  const cached = await readJson<ManagedProviderTurnIndex>(providerTurnIndexPath(root))
  const fresh =
    cached?.schemaVersion === 1 &&
    !!cached.providerTurnRecordIds &&
    cached.stamp?.count === stamp.count &&
    cached.stamp?.maxSequence === stamp.maxSequence
  return { stamp, index: fresh ? cached : null }
}

/**
 * 全量扫描后重建缓存。`stamp` 必须是扫描前取的：扫描期间落地的新记录会让
 * 下一次指纹对不上，从而再重建一次——宁可多扫一次，不能把没看见的记录当成不存在。
 */
async function rebuildProviderTurnIndex(
  root: string,
  stamp: { count: number; maxSequence: number },
  records: readonly AgentTurnRecord[],
  provider: ManagedRecorderProviderId,
  sessionId: string
): Promise<void> {
  const providerTurnRecordIds: Record<string, string> = {}
  for (const record of records) {
    if (record.provider.id !== provider || record.sessionId !== sessionId || !record.providerTurnId) continue
    providerTurnRecordIds[record.providerTurnId] = record.recordId
  }
  await writeJsonAtomic(
    providerTurnIndexPath(root),
    { schemaVersion: 1, stamp, providerTurnRecordIds } satisfies ManagedProviderTurnIndex,
    { sync: false }
  )
}

/** 提交成功后增量推进缓存，否则每轮提交都会让下一轮退回全量扫描。 */
async function advanceProviderTurnIndex(
  dataRoot: string,
  root: string,
  record: AgentTurnRecord
): Promise<void> {
  const cached = await readJson<ManagedProviderTurnIndex>(providerTurnIndexPath(root))
  if (cached?.schemaVersion !== 1 || !cached.providerTurnRecordIds) return
  await writeJsonAtomic(
    providerTurnIndexPath(root),
    {
      schemaVersion: 1,
      stamp: await recordStoreStamp(dataRoot),
      providerTurnRecordIds: {
        ...cached.providerTurnRecordIds,
        ...(record.providerTurnId ? { [record.providerTurnId]: record.recordId } : {})
      }
    } satisfies ManagedProviderTurnIndex,
    { sync: false }
  )
}

async function recordByProviderTurnId(
  dataRoot: string,
  root: string,
  provider: ManagedRecorderProviderId,
  sessionId: string,
  providerTurnId: string
): Promise<AgentTurnRecord | undefined> {
  const { stamp, index } = await readProviderTurnIndex(dataRoot, root)
  if (index) {
    const recordId = index.providerTurnRecordIds[providerTurnId]
    // 缓存与 records 同鲜且不含该 providerTurnId → 可信的否定结论。
    if (!recordId) return undefined
    const record = await findRecordById(dataRoot, recordId)
    if (
      record &&
      record.provider.id === provider &&
      record.sessionId === sessionId &&
      record.providerTurnId === providerTurnId
    ) return record
    // 缓存指向的记录已不自洽 → 落回权威全量扫描，不猜。
  }
  const records = await listRecords(dataRoot)
  const matches = records.filter(
    (record) =>
      record.provider.id === provider &&
      record.sessionId === sessionId &&
      record.providerTurnId === providerTurnId
  )
  if (matches.length > 1) {
    throw new Error('managed recorder found multiple records for one provider turn')
  }
  await rebuildProviderTurnIndex(root, stamp, records, provider, sessionId)
  return matches[0]
}

async function handoffs(root: string): Promise<Array<{ path: string; handoff: ManagedTurnHandoff }>> {
  const out: Array<{ path: string; handoff: ManagedTurnHandoff }> = []
  for (const generation of await listFiles(join(root, 'turns'))) {
    const path = join(root, 'turns', generation, 'canonical.json')
    const handoff = await readJson<ManagedTurnHandoff>(path)
    if (handoff?.schemaVersion === 1) out.push({ path, handoff })
  }
  return out
}

async function handoffForRun(root: string, runId: string): Promise<{ path: string; handoff: ManagedTurnHandoff } | undefined> {
  return (await handoffs(root)).find((item) => item.handoff.runId === runId)
}

function recordDraft(
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

function assertDuplicateMatchesInput(record: AgentTurnRecord, input: PrepareManagedTurnInput): void {
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

function assertCommittedRecordMatchesHandoff(
  record: AgentTurnRecord,
  handoff: ManagedTurnHandoff
): void {
  const { sequence: _sequence, ...draft } = record
  if (stableHash(draft) !== stableHash(handoff.record)) {
    throw new Error('managed recorder duplicate record differs from prepared canonical handoff')
  }
}

export async function prepareManagedRecorderTurn(input: PrepareManagedTurnInput): Promise<ManagedTurnResult> {
  const mode = await managedRecorderMode(input.workspace, input.env)
  if (mode.status === 'disabled') return mode
  assertProtectedToolEvidence(input.evidence, isFullToolContentPolicy(input.toolContentPolicy) ? input.toolContentPolicy : mode.enablement.config.capture)
  assertExactText(input.evidence.user, input.userText, 'user')
  if (
    (input.provider === 'claude' || input.provider === 'qoder' || input.provider === 'opencode' || input.provider === 'pi') &&
    input.status !== 'completed'
  ) {
    assertOptionalAssistantText(input.evidence.assistant)
  } else {
    assertExactText(input.evidence.assistant, undefined, 'assistant')
  }
  assertTiming(input.timing)
  const { enablement } = mode

  return withRecorderSessionLock(enablement.dataRoot, input.provider, input.sessionId, async () => {
    if (input.expectedRecordId) {
      const duplicate = await recordById(enablement.dataRoot, input.expectedRecordId)
      if (duplicate) {
        assertDuplicateMatchesInput(duplicate, input)
        return { status: 'duplicate' as const, recordId: duplicate.recordId, record: duplicate }
      }
    }
    if (input.allowObservedInterruption) {
      const duplicate = await recordById(enablement.dataRoot, observedInterruptionRecordId(enablement.config.workspaceId, input))
      if (duplicate) {
        assertDuplicateMatchesInput(duplicate, input)
        return { status: 'duplicate' as const, recordId: duplicate.recordId, record: duplicate }
      }
    }
    const sessionRoot = recorderSessionRoot(enablement.dataRoot, input.provider, input.sessionId)
    const providerDuplicate = input.providerTurnId
      ? await recordByProviderTurnId(
          enablement.dataRoot,
          sessionRoot,
          input.provider,
          input.sessionId,
          input.providerTurnId
        )
      : undefined
    if (providerDuplicate) {
      assertDuplicateMatchesInput(providerDuplicate, input)
      return {
        status: 'duplicate' as const,
        recordId: providerDuplicate.recordId,
        record: providerDuplicate
      }
    }
    const root = sessionRoot
    const existing = await handoffForRun(root, input.runId)
    if (existing) {
      if (existing.handoff.archiveFingerprint !== input.archiveFingerprint) {
        throw new Error('managed recorder prepared handoff differs from canonical Scry evidence')
      }
      assertDuplicateMatchesInput(
        { ...existing.handoff.record, sequence: 1 },
        input
      )
      return { status: 'prepared' as const, recordId: existing.handoff.record.recordId }
    }

    const current = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
    const candidates = [
      ...(current ? [current] : []),
      ...(await recorderQuarantinedOpenTurns(root))
    ]
    let matches = candidates.filter(
      (candidate) =>
        candidate.managedByScry &&
        candidate.providerTurnId === input.providerTurnId
    )
    const provisional = candidates.filter((candidate) => candidate.managedByScry && !candidate.providerTurnId)
    const supportsProvisionalIdentity = input.provider === 'claude' || input.provider === 'qoder' || input.provider === 'opencode' || input.provider === 'pi'
    const matchingProvisional = supportsProvisionalIdentity
      ? provisional.filter((candidate) => managedProvisionalMatches(candidate, input))
      : []
    if (
      matches.length === 0 &&
      supportsProvisionalIdentity &&
      current?.managedByScry &&
      !current.providerTurnId &&
      matchingProvisional.length === 1 &&
      matchingProvisional[0] === current
    ) {
      const bound = { ...current, providerTurnId: input.providerTurnId }
      await writeJsonAtomic(recorderOpenPath(root), bound, { sync: false })
      matches = [bound]
    }
    if (!input.providerTurnId) {
      const permitsMissingProviderTurnId = managedRecorderAllowsMissingProviderTurnId(input.provider, input.status)
      if (!permitsMissingProviderTurnId) {
        throw new Error('managed recorder requires an authoritative Provider turn id')
      }
      matches = matchingProvisional
    }
    let observedInterruption = false
    if (matches.length === 0 && candidates.length === 0) {
      const canonicalRecovery = await reserveCanonicalJournalRecovery(enablement.dataRoot, root, input)
      if (canonicalRecovery) {
        matches = [canonicalRecovery]
      } else {
        const reserved = await reserveObservedInterruption(enablement.dataRoot, root, input)
        if (reserved) {
          matches = [reserved]
          observedInterruption = true
        }
      }
    }
    if (matches.length === 0) {
      if (candidates.length === 0) {
        return { status: 'pending' as const, reason: 'managed recorder open identity is not available yet' }
      }
      throw new Error('managed recorder Provider turn id differs from the open lifecycle identity')
    }
    if (matches.length !== 1) {
      throw new Error('managed recorder Provider turn id differs from the open lifecycle identity')
    }
    const open = matches[0]

    const draft = recordDraft(enablement, open, input)
    if (observedInterruption && draft.termination) {
      draft.recordId = observedInterruptionRecordId(enablement.config.workspaceId, input)
      draft.termination = {
        ...draft.termination,
        omissionReason: 'no Provider lifecycle start was captured; this interrupted attempt uses the durable Scry run boundary, not a Provider turn identity'
      }
    }
    if (!isAgentTurnRecord({ ...draft, sequence: 1 })) throw new Error('managed recorder produced an invalid canonical record')
    const handoff: ManagedTurnHandoff = {
      schemaVersion: 1,
      phase: 'prepared',
      runId: input.runId,
      archiveFingerprint: input.archiveFingerprint,
      preparedAt: new Date().toISOString(),
      record: draft
    }
    await writeJsonAtomic(canonicalPath(root, open.generation), handoff)
    return { status: 'prepared' as const, recordId: draft.recordId }
  }, { waitMs: SESSION_LOCK_WAIT_MS })
}

async function commitHandoff(
  enablement: EnabledRecorder,
  root: string,
  handoff: ManagedTurnHandoff
): Promise<Extract<ManagedTurnResult, { status: 'committed' | 'duplicate' }>> {
  if (handoff.phase !== 'archive_committed') throw new Error('managed recorder handoff archive is not committed')
  if (!isAgentTurnRecord({ ...handoff.record, sequence: 1 })) throw new Error('managed recorder handoff contains an invalid record')
  const committed = await commitRecord(enablement.dataRoot, handoff.record)
  if (committed.status === 'duplicate') {
    assertCommittedRecordMatchesHandoff(committed.record, handoff)
  }
  await advanceProviderTurnIndex(enablement.dataRoot, root, committed.record)
  const session = await readJson<RecorderSessionState>(recorderStatePath(root)) ?? {
    schemaVersion: 1,
    lastGeneration: handoff.record.generation,
    lastTurnIndex: handoff.record.turnIndex
  }
  const committedProviderTurnIds = handoff.record.providerTurnId
    ? [...new Set([...(session.committedProviderTurnIds ?? []), handoff.record.providerTurnId])].slice(-200)
    : session.committedProviderTurnIds
  await writeJsonAtomic(recorderStatePath(root), {
    ...session,
    lastGeneration: Math.max(session.lastGeneration, handoff.record.generation),
    lastTurnIndex: Math.max(session.lastTurnIndex, handoff.record.turnIndex),
    lastCommittedRecordId: committed.record.recordId,
    ...(committedProviderTurnIds ? { committedProviderTurnIds } : {})
  }, { sync: false })
  const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
  if (open?.generation === handoff.record.generation) await rm(recorderOpenPath(root), { force: true })
  await clearRuntimeTurn(enablement.dataRoot, recorderTurnRoot(root, handoff.record.generation))
  await updateHealth(enablement.dataRoot, {
    ...(await recorderPendingHealth(enablement.dataRoot)),
    lastSuccessAt: new Date().toISOString(),
    lastError: undefined
  })
  return { status: committed.status, recordId: committed.record.recordId, record: committed.record }
}

/**
 * 提交通知的投递位置。`await` 用于 CLI/recover：进程随后就退出，必须先把这一批投递完。
 * `detach` 用于常驻 App：record 已经落盘，向仓库回调投递只是下游观测，绝不能挂在用户看到
 * 轮次收口之前——每条通知都要起一次仓库回调进程，积压时会把“运行中”拖到分钟级。剩余积压由
 * 下一次 hook、`recorder recover` 或 `recorder notify-drain` 继续投递，ACK 游标是持久化的，
 * 因此不会丢证据。
 */
export type CommitNotificationDelivery = 'await' | 'detach'

async function deliverCommitNotifications(
  dataRoot: string,
  env: NodeJS.ProcessEnv | undefined,
  delivery: CommitNotificationDelivery
): Promise<void> {
  const drain = (): Promise<unknown> => drainCommitNotifications(dataRoot, env, {
    maxRecords: HOOK_DRAIN_MAX_RECORDS,
    budgetMs: HOOK_DRAIN_BUDGET_MS
  })
  if (delivery === 'detach') {
    void drain().catch(() => undefined)
    return
  }
  await drain()
}

export async function commitManagedRecorderTurn(input: {
  workspace: string
  provider: ManagedRecorderProviderId
  sessionId: string
  runId: string
  recordId: string
  archiveFingerprint: string
  providerTurnId?: string
  userText: string
  evidence: TurnEvidence
  timing: ManagedTurnTiming
  status: AgentTurnRecord['status']
  env?: NodeJS.ProcessEnv
  commitNotifications?: CommitNotificationDelivery
}): Promise<ManagedTurnResult> {
  const mode = await managedRecorderMode(input.workspace, input.env)
  if (mode.status === 'disabled') return mode
  const { enablement } = mode
  const result = await withRecorderSessionLock(enablement.dataRoot, input.provider, input.sessionId, async () => {
    const duplicate = await recordById(enablement.dataRoot, input.recordId)
    const root = recorderSessionRoot(enablement.dataRoot, input.provider, input.sessionId)
    const existing = await handoffForRun(root, input.runId)
    if (duplicate && !existing) {
      assertDuplicateMatchesInput(duplicate, input)
      return { status: 'duplicate' as const, recordId: duplicate.recordId, record: duplicate }
    }
    if (!existing) return { status: 'pending' as const, reason: 'managed recorder prepared handoff is missing' }
    if (
      existing.handoff.record.recordId !== input.recordId ||
      existing.handoff.archiveFingerprint !== input.archiveFingerprint
    ) throw new Error('managed recorder commit identity differs from prepared handoff')
    const committedHandoff: ManagedTurnHandoff = { ...existing.handoff, phase: 'archive_committed' }
    await writeJsonAtomic(existing.path, committedHandoff)
    return commitHandoff(enablement, root, committedHandoff)
  }, { waitMs: SESSION_LOCK_WAIT_MS })
  // canonical record 此时已落盘；通知投递是下游观测，不参与本轮是否成功的判定。
  await deliverCommitNotifications(enablement.dataRoot, input.env, input.commitNotifications ?? 'await')
  return result
}

// 已开的轮次只有在“还有人能把它收口”时才值得阻断下一轮。没有 providerTurnId、没有 canonical handoff，
// 并且它的 managedRunId 已不是本进程里活的 run（进程早没了），这种 provisional 状态永远不会自己
// 收口，留着只会把该工作区+Provider 永久卡在“仍有 N 轮待恢复”。这里按与
// cancelManagedRecorderTurn 相同的证据标准弃掉它；一旦出现真的 Provider 证据（providerTurnId
// 或已备好的 canonical handoff），仍然 fail closed。
async function abandonProvisionalOpenTurn(
  root: string,
  dataRoot: string,
  state: RecorderOpenTurnState,
  statePath: string,
  isLiveManagedRun: (runId: string | undefined) => boolean
): Promise<boolean> {
  if (state.providerTurnId) return false
  if (isLiveManagedRun(state.managedRunId)) return false
  if (await readJson<ManagedTurnHandoff>(canonicalPath(root, state.generation))) return false
  await rm(statePath, { force: true })
  await clearRuntimeTurn(dataRoot, recorderTurnRoot(root, state.generation))
  return true
}

export async function recoverManagedRecorderTurns(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    sessionId?: string
    provider?: ManagedRecorderProviderId
    // 默认保守：不知道哪些 run 还活着时，不弃掉任何 open 状态（否则可能删掉正在跑的轮次）。
    // 调用方（main）知道 run 存活情况时传入 abandonProvisional，才会清理不可恢复的 provisional 轮次。
    abandonProvisional?: boolean
    // App 拥有的活跃轮次由原执行链收口；恢复不得重放它们，也不把它们计为 pending。
    isLiveManagedRun?: (runId: string | undefined, nativeIdentity?: Pick<RecorderOpenTurnState, 'provider' | 'sessionId' | 'providerTurnId'>) => boolean
    // 常驻 App 走 'detach'：恢复检查在“发送前”跑，不能被仓库回调积压拖住发送。
    commitNotifications?: CommitNotificationDelivery
  } = {}
): Promise<{ recovered: number; pending: number }> {
  const mode = await managedRecorderMode(workspace, env)
  if (mode.status === 'disabled') return { recovered: 0, pending: 0 }
  const { enablement } = mode
  let recovered = 0
  let pending = 0
  const providers: ManagedRecorderProviderId[] = options.provider
    ? [options.provider]
    : ['claude', 'codex', 'qoder', 'opencode', 'pi']
  for (const provider of providers) {
    const providerRoot = join(enablement.dataRoot, 'runtime', provider)
    for (const sessionDir of await listFiles(providerRoot)) {
      const root = join(providerRoot, sessionDir)
      const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
      const quarantined = await recorderQuarantinedOpenTurns(root)
      const items = (await handoffs(root)).filter(
        (item) => !options.sessionId || item.handoff.record.sessionId === options.sessionId
      )
      if (
        options.sessionId &&
        open?.sessionId !== options.sessionId &&
        items.length === 0 &&
        !quarantined.some((item) => item.sessionId === options.sessionId)
      ) continue
      for (const item of items) {
        if (options.isLiveManagedRun?.(item.handoff.runId)) continue
        if (item.handoff.phase !== 'archive_committed') {
          pending++
          continue
        }
        const result = await withRecorderSessionLock(
          enablement.dataRoot, provider, item.handoff.record.sessionId,
          () => commitHandoff(enablement, root, item.handoff),
          { waitMs: SESSION_LOCK_WAIT_MS }
        )
        if (result.status === 'committed' || result.status === 'duplicate') recovered++
      }
      const isLiveManagedRun = options.abandonProvisional
        ? options.isLiveManagedRun ?? ((): boolean => false)
        : ((): boolean => true)
      if (
        open &&
        (open.managedByScry || open.status === 'closing') &&
        !options.isLiveManagedRun?.(open.managedRunId, open) &&
        (!options.sessionId || open.sessionId === options.sessionId) &&
        !items.some((item) => item.handoff.record.generation === open.generation)
      ) {
        const abandoned = await withRecorderSessionLock(
          enablement.dataRoot, provider, open.sessionId,
          () => abandonProvisionalOpenTurn(root, enablement.dataRoot, open, recorderOpenPath(root), isLiveManagedRun),
          { waitMs: SESSION_LOCK_WAIT_MS }
        ).catch(() => false)
        if (abandoned) recovered++
        else pending++
      }
      for (const pendingOpen of quarantined) {
        if (
          (!options.sessionId || pendingOpen.sessionId === options.sessionId) &&
          !options.isLiveManagedRun?.(pendingOpen.managedRunId, pendingOpen) &&
          !items.some((item) => item.handoff.record.generation === pendingOpen.generation)
        ) {
          const abandoned = await withRecorderSessionLock(
            enablement.dataRoot, provider, pendingOpen.sessionId,
            () => abandonProvisionalOpenTurn(
              root,
              enablement.dataRoot,
              pendingOpen,
              join(recorderTurnRoot(root, pendingOpen.generation), 'pending-open.json'),
              isLiveManagedRun
            ),
            { waitMs: SESSION_LOCK_WAIT_MS }
          ).catch(() => false)
          if (abandoned) recovered++
          else pending++
        }
      }
    }
  }
  // agent:start 每一轮都会跑到这里；同步投递会把发送卡在“正在启动”。
  await deliverCommitNotifications(enablement.dataRoot, env, options.commitNotifications ?? 'await')
  return { recovered, pending }
}
