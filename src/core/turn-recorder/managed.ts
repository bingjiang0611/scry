import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import {
  isAgentTurnRecord,
  type AgentTurnRecord,
  type Evidence,
  type TurnEvidence
} from '../../shared/turn-record.js'
import { resolveRecorderEnablement, type RecorderEnablement } from './config.js'
import { listFiles, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'
import {
  SESSION_LOCK_WAIT_MS,
  recorderOpenPath,
  recorderPendingHealth,
  recorderQuarantinedOpenTurns,
  recorderSessionLock,
  recorderSessionRoot,
  recorderStatePath,
  recorderTurnRoot,
  type RecorderOpenTurnState,
  type RecorderSessionState
} from './runtime-state.js'
import {
  RECORDER_VERSION,
  clearRuntimeTurn,
  commitRecord,
  listRecords,
  stableHash,
  updateHealth
} from './store.js'

export interface ManagedTurnTiming {
  startedAt: string
  completedAt: string
  durationMs: number
}

export type ManagedRecorderProviderId = Extract<ProviderId, 'claude' | 'codex' | 'qoder'>

export function isManagedRecorderProvider(provider: ProviderId): provider is ManagedRecorderProviderId {
  return provider === 'claude' || provider === 'codex' || provider === 'qoder'
}

export interface PrepareManagedTurnInput {
  workspace: string
  provider: ManagedRecorderProviderId
  sessionId: string
  runId: string
  providerTurnId: string
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

function assertExactText(
  evidence: Evidence<{ text?: string; textHash?: string }>,
  expected: string | undefined,
  label: 'user' | 'assistant'
): void {
  const text = evidence.value?.text
  if (evidence.status !== 'available' || evidence.quality !== 'exact' || !text) {
    throw new Error(`managed recorder requires non-empty exact ${label} evidence`)
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

function assertStrictCapture(enablement: EnabledRecorder): void {
  const capture = enablement.config.capture
  const missing = [
    !capture.prompt && 'prompt',
    !capture.assistant && 'assistant',
    capture.toolOutput !== 'summary' && 'toolOutput=summary',
    !capture.diff && 'diff',
    !capture.hooks && 'hooks'
  ].filter((value): value is string => !!value)
  if (missing.length) throw new Error(`managed recorder strict capture is disabled: ${missing.join(', ')}`)
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
  return (await listRecords(dataRoot)).find((record) => record.recordId === recordId)
}

async function recordByProviderTurnId(
  dataRoot: string,
  provider: ManagedRecorderProviderId,
  sessionId: string,
  providerTurnId: string
): Promise<AgentTurnRecord | undefined> {
  const matches = (await listRecords(dataRoot)).filter(
    (record) =>
      record.provider.id === provider &&
      record.sessionId === sessionId &&
      record.providerTurnId === providerTurnId
  )
  if (matches.length > 1) {
    throw new Error('managed recorder found multiple records for one provider turn')
  }
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
    providerTurnId: input.providerTurnId,
    generation: open.generation,
    turnIndex: open.turnIndex,
    ...input.timing,
    status: input.status,
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
    ...(record.modelTiming ? { modelTiming: record.modelTiming } : {}),
    files: record.files,
    diff: record.diff,
    dangerousOperations: record.dangerousOperations,
    errors: record.errors
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
  assertExactText(input.evidence.user, input.userText, 'user')
  if ((input.provider === 'claude' || input.provider === 'qoder') && input.status !== 'completed') {
    assertOptionalAssistantText(input.evidence.assistant)
  } else {
    assertExactText(input.evidence.assistant, undefined, 'assistant')
  }
  assertTiming(input.timing)
  const { enablement } = mode

  return withDirectoryLock(recorderSessionLock(enablement.dataRoot, input.provider, input.sessionId), async () => {
    if (input.expectedRecordId) {
      const duplicate = await recordById(enablement.dataRoot, input.expectedRecordId)
      if (duplicate) {
        assertDuplicateMatchesInput(duplicate, input)
        return { status: 'duplicate' as const, recordId: duplicate.recordId, record: duplicate }
      }
    }
    const providerDuplicate = await recordByProviderTurnId(
      enablement.dataRoot,
      input.provider,
      input.sessionId,
      input.providerTurnId
    )
    if (providerDuplicate) {
      assertDuplicateMatchesInput(providerDuplicate, input)
      return {
        status: 'duplicate' as const,
        recordId: providerDuplicate.recordId,
        record: providerDuplicate
      }
    }
    const root = recorderSessionRoot(enablement.dataRoot, input.provider, input.sessionId)
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
    if (
      matches.length === 0 &&
      input.provider === 'qoder' &&
      current?.managedByScry &&
      !current.providerTurnId &&
      provisional.length === 1
    ) {
      const bound = { ...current, providerTurnId: input.providerTurnId }
      await writeJsonAtomic(recorderOpenPath(root), bound, { sync: false })
      matches = [bound]
    }
    if (matches.length === 0 && candidates.length === 0) {
      return { status: 'pending' as const, reason: 'managed recorder open identity is not available yet' }
    }
    if (matches.length !== 1) {
      throw new Error('managed recorder Provider turn id differs from the open lifecycle identity')
    }
    const open = matches[0]

    const draft = recordDraft(enablement, open, input)
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

export async function commitManagedRecorderTurn(input: {
  workspace: string
  provider: ManagedRecorderProviderId
  sessionId: string
  runId: string
  recordId: string
  archiveFingerprint: string
  providerTurnId: string
  userText: string
  evidence: TurnEvidence
  timing: ManagedTurnTiming
  status: AgentTurnRecord['status']
  env?: NodeJS.ProcessEnv
}): Promise<ManagedTurnResult> {
  const mode = await managedRecorderMode(input.workspace, input.env)
  if (mode.status === 'disabled') return mode
  const { enablement } = mode
  return withDirectoryLock(recorderSessionLock(enablement.dataRoot, input.provider, input.sessionId), async () => {
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
}

export async function recoverManagedRecorderTurns(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { sessionId?: string; provider?: ManagedRecorderProviderId } = {}
): Promise<{ recovered: number; pending: number }> {
  const mode = await managedRecorderMode(workspace, env)
  if (mode.status === 'disabled') return { recovered: 0, pending: 0 }
  const { enablement } = mode
  let recovered = 0
  let pending = 0
  const providers: ManagedRecorderProviderId[] = options.provider ? [options.provider] : ['claude', 'codex', 'qoder']
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
        if (item.handoff.phase !== 'archive_committed') {
          pending++
          continue
        }
        const result = await withDirectoryLock(
          recorderSessionLock(enablement.dataRoot, provider, item.handoff.record.sessionId),
          () => commitHandoff(enablement, root, item.handoff),
          { waitMs: SESSION_LOCK_WAIT_MS }
        )
        if (result.status === 'committed' || result.status === 'duplicate') recovered++
      }
      if (
        open &&
        (open.managedByScry || open.status === 'closing') &&
        (!options.sessionId || open.sessionId === options.sessionId) &&
        !items.some((item) => item.handoff.record.generation === open.generation)
      ) {
        pending++
      }
      for (const pendingOpen of quarantined) {
        if (
          (!options.sessionId || pendingOpen.sessionId === options.sessionId) &&
          !items.some((item) => item.handoff.record.generation === pendingOpen.generation)
        ) {
          pending++
        }
      }
    }
  }
  return { recovered, pending }
}
