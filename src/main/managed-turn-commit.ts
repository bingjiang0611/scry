import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeProvider } from '../shared/runtime.js'
import type { ProviderId } from '../shared/provider.js'
import type { AgentTurnRecord } from '../shared/turn-record.js'
import {
  commitManagedRecorderTurn,
  managedRecorderMode,
  prepareManagedRecorderTurn,
  type ManagedRecorderProviderId,
  type ManagedTurnTiming
} from '../core/turn-recorder/managed.js'
import { listFiles, readJson, withDirectoryLock, writeJsonAtomic } from '../core/turn-recorder/io.js'
import { safeKey, stableHash } from '../core/turn-recorder/store.js'
import {
  readTraceArchive,
  upsertTraceArchiveTurn,
  type TraceArchiveTurn
} from './transcript-archive.js'

interface ManagedTurnJournal {
  schemaVersion: 1
  phase: 'prepared' | 'archive_committed'
  archiveFingerprint: string
  recordId?: string
  request: {
    cwd: string
    sessionId: string
    providerTurnId: string
    providerId: ManagedRecorderProviderId
    runtimeProvider: RuntimeProvider
    turn: TraceArchiveTurn
    timing: ManagedTurnTiming
    status: AgentTurnRecord['status']
  }
}

interface ManagedTurnProgress {
  schemaVersion: 1
  persistedAt: string
  request: Omit<ManagedTraceTurnCommitInput, 'userDataDir'>
}

export interface ManagedTraceTurnCommitInput {
  userDataDir: string
  cwd: string
  sessionId: string
  providerTurnId: string
  providerId: ManagedRecorderProviderId
  runtimeProvider: RuntimeProvider
  turn: TraceArchiveTurn
  timing: ManagedTurnTiming
  status: AgentTurnRecord['status']
}

export interface ManagedTurnRecovery {
  recovered: number
  pending: number
  errors: string[]
}

function journalRoot(userDataDir: string): string {
  return join(userDataDir, 'managed-turn-commits')
}

function progressRoot(userDataDir: string): string {
  return join(userDataDir, 'managed-turn-progress')
}

function progressPath(userDataDir: string, runId: string): string {
  return join(progressRoot(userDataDir), `${safeKey(runId)}.json`)
}

function journalPath(userDataDir: string, runId: string): string {
  return join(journalRoot(userDataDir), `${safeKey(runId)}.json`)
}

function lockPath(userDataDir: string, runId: string): string {
  return join(journalRoot(userDataDir), 'locks', `${safeKey(runId)}.lock`)
}

function archiveFingerprint(input: ManagedTraceTurnCommitInput): string {
  return stableHash({
    cwd: input.cwd,
    sessionId: input.sessionId,
    providerId: input.providerId,
    runtimeProvider: input.runtimeProvider,
    turn: input.turn,
    timing: input.timing,
    status: input.status
  })
}

function providerTurnFingerprint(turn: TraceArchiveTurn): string {
  return stableHash({
    providerTurnId: turn.providerTurnId,
    userText: turn.userText,
    attachments: turn.attachments,
    turnEvidence: turn.turnEvidence,
    done: turn.done,
    status: turn.status,
    error: turn.error,
    errorHint: turn.errorHint,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs
  })
}

function assertManagedTraceInput(input: ManagedTraceTurnCommitInput): void {
  if (!input.providerTurnId || input.turn.providerTurnId !== input.providerTurnId) {
    throw new Error('managed recorder archive turn id differs from authoritative Provider turn id')
  }
  if (!input.turn.turnEvidence) {
    throw new Error('managed recorder archive turn is missing TurnEvidence')
  }
  if (
    input.turn.status !== input.status ||
    input.turn.startedAt !== input.timing.startedAt ||
    input.turn.completedAt !== input.timing.completedAt ||
    input.turn.durationMs !== input.timing.durationMs
  ) {
    throw new Error('managed recorder archive metadata differs from canonical CLI metadata')
  }
}

function assertProgressIdentity(
  existing: ManagedTurnProgress,
  input: ManagedTraceTurnCommitInput
): void {
  const request = existing.request
  if (
    request.cwd !== input.cwd ||
    request.sessionId !== input.sessionId ||
    request.providerTurnId !== input.providerTurnId ||
    request.providerId !== input.providerId ||
    request.runtimeProvider !== input.runtimeProvider ||
    request.turn.runId !== input.turn.runId
  ) {
    throw new Error(`managed recorder progress collision for ${input.turn.runId}`)
  }
}

function archiveJournal(journal: ManagedTurnJournal, userDataDir: string): void {
  const request = journal.request
  const archive = readTraceArchive({
    cwd: request.cwd,
    sessionId: request.sessionId,
    providerId: request.providerId,
    userDataDir
  })
  const providerExisting = archive?.turns.find(
    (turn) => turn.providerTurnId === request.providerTurnId
  )
  if (providerExisting) {
    if (providerTurnFingerprint(providerExisting) !== providerTurnFingerprint(request.turn)) {
      throw new Error(`managed recorder Provider turn collision for ${request.providerTurnId}`)
    }
    return
  }
  const existing = archive?.turns.find((turn) => turn.runId === request.turn.runId)
  if (existing && stableHash(existing) !== stableHash(request.turn)) {
    throw new Error(`managed recorder archive collision for ${request.turn.runId}`)
  }
  const ok = upsertTraceArchiveTurn({
    cwd: request.cwd,
    sessionId: request.sessionId,
    providerId: request.providerId,
    runtimeProvider: request.runtimeProvider,
    userDataDir,
    turn: request.turn
  })
  if (!ok) throw new Error(`managed recorder could not persist Scry archive for ${request.turn.runId}`)
}

async function prepareJournalRecord(
  journal: ManagedTurnJournal,
  waitMs: number
): Promise<ManagedTurnJournal> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const request = journal.request
    const evidence = request.turn.turnEvidence
    if (!evidence) throw new Error('managed recorder journal is missing TurnEvidence')
    const prepared = await prepareManagedRecorderTurn({
      workspace: request.cwd,
      provider: request.providerId,
      sessionId: request.sessionId,
      providerTurnId: request.providerTurnId,
      runId: request.turn.runId,
      userText: request.turn.userText,
      evidence,
      timing: request.timing,
      status: request.status,
      archiveFingerprint: journal.archiveFingerprint,
      expectedRecordId: journal.recordId
    })
    if (prepared.status === 'disabled') {
      throw new Error(`managed recorder became disabled while a canonical journal was pending: ${prepared.reason}`)
    }
    if ('recordId' in prepared) return { ...journal, recordId: prepared.recordId }
    if (Date.now() >= deadline) throw new Error(prepared.reason)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function replayJournal(
  path: string,
  userDataDir: string,
  journal: ManagedTurnJournal,
  waitMs: number
): Promise<'recovered' | 'pending'> {
  const input: ManagedTraceTurnCommitInput = {
    ...journal.request,
    userDataDir
  }
  assertManagedTraceInput(input)
  if (archiveFingerprint(input) !== journal.archiveFingerprint) {
    throw new Error(`managed recorder journal fingerprint mismatch for ${journal.request.turn.runId}`)
  }
  try {
    const prepared = await prepareJournalRecord(journal, waitMs)
    await writeJsonAtomic(path, prepared)
    archiveJournal(prepared, userDataDir)
    const archiveCommitted: ManagedTurnJournal = { ...prepared, phase: 'archive_committed' }
    await writeJsonAtomic(path, archiveCommitted)
    if (!archiveCommitted.recordId) throw new Error('managed recorder journal has no prepared record id')
    const evidence = archiveCommitted.request.turn.turnEvidence
    if (!evidence) throw new Error('managed recorder journal is missing TurnEvidence')
    const committed = await commitManagedRecorderTurn({
      workspace: archiveCommitted.request.cwd,
      provider: archiveCommitted.request.providerId,
      sessionId: archiveCommitted.request.sessionId,
      runId: archiveCommitted.request.turn.runId,
      recordId: archiveCommitted.recordId,
      archiveFingerprint: archiveCommitted.archiveFingerprint,
      providerTurnId: archiveCommitted.request.providerTurnId,
      userText: archiveCommitted.request.turn.userText,
      evidence,
      timing: archiveCommitted.request.timing,
      status: archiveCommitted.request.status
    })
    if (committed.status === 'disabled' || committed.status === 'pending' || committed.status === 'prepared') {
      throw new Error('reason' in committed ? committed.reason : 'managed recorder canonical commit is still pending')
    }
    await rm(path, { force: true })
    return 'recovered'
  } catch {
    return 'pending'
  }
}

export function canonicalTurnTiming(events: Array<{
  kind: string
  stage: string
  ts: string
  durationMs?: number
  text?: string
}>): ManagedTurnTiming | null {
  const result = [...events].reverse().find((event) =>
    event.kind === 'harness' &&
    event.stage === 'result' &&
    event.text !== 'transcript assistant usage' &&
    Number.isFinite(event.durationMs) &&
    Number(event.durationMs) >= 0 &&
    Number.isFinite(Date.parse(event.ts))
  )
  if (!result || result.durationMs == null) return null
  const completed = Date.parse(result.ts)
  return {
    startedAt: new Date(completed - result.durationMs).toISOString(),
    completedAt: new Date(completed).toISOString(),
    durationMs: result.durationMs
  }
}

export function canonicalOrObservedTurnTiming(
  events: Parameters<typeof canonicalTurnTiming>[0],
  providerId: ProviderId,
  status: AgentTurnRecord['status'],
  observed?: ManagedTurnTiming
): ManagedTurnTiming | null {
  const canonical = canonicalTurnTiming(events)
  if (canonical || providerId !== 'qoder' || status === 'completed' || !observed) return canonical
  const started = Date.parse(observed.startedAt)
  const completed = Date.parse(observed.completedAt)
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    !Number.isFinite(observed.durationMs) ||
    observed.durationMs < 0 ||
    Math.max(0, completed - started) !== observed.durationMs
  ) return null
  return observed
}

export async function commitManagedTraceTurn(
  input: ManagedTraceTurnCommitInput,
  options: { waitMs?: number } = {}
): Promise<{ recorder: 'disabled' | 'committed'; recordId?: string }> {
  assertManagedTraceInput(input)
  const mode = await managedRecorderMode(input.cwd)
  if (mode.status === 'disabled') {
    const ok = upsertTraceArchiveTurn({
      cwd: input.cwd,
      sessionId: input.sessionId,
      providerId: input.providerId,
      runtimeProvider: input.runtimeProvider,
      userDataDir: input.userDataDir,
      turn: input.turn
    })
    if (!ok) throw new Error(`could not persist Scry archive for ${input.turn.runId}`)
    await rm(progressPath(input.userDataDir, input.turn.runId), { force: true })
    return { recorder: 'disabled' }
  }

  const path = journalPath(input.userDataDir, input.turn.runId)
  return withDirectoryLock(lockPath(input.userDataDir, input.turn.runId), async () => {
    const fingerprint = archiveFingerprint(input)
    const existing = await readJson<ManagedTurnJournal>(path)
    if (existing && existing.archiveFingerprint !== fingerprint) {
      throw new Error(`managed recorder journal collision for ${input.turn.runId}`)
    }
    const journal: ManagedTurnJournal = existing ?? {
      schemaVersion: 1,
      phase: 'prepared',
      archiveFingerprint: fingerprint,
      request: {
        cwd: input.cwd,
        sessionId: input.sessionId,
        providerTurnId: input.providerTurnId,
        providerId: input.providerId,
        runtimeProvider: input.runtimeProvider,
        turn: input.turn,
        timing: input.timing,
        status: input.status
      }
    }
    await writeJsonAtomic(path, journal)
    const prepared = await prepareJournalRecord(journal, options.waitMs ?? 5_000)
    await writeJsonAtomic(path, prepared)
    archiveJournal(prepared, input.userDataDir)
    const archiveCommitted: ManagedTurnJournal = { ...prepared, phase: 'archive_committed' }
    await writeJsonAtomic(path, archiveCommitted)
    if (!archiveCommitted.recordId) throw new Error('managed recorder journal has no prepared record id')
    const evidence = archiveCommitted.request.turn.turnEvidence
    if (!evidence) throw new Error('managed recorder journal is missing TurnEvidence')
    const committed = await commitManagedRecorderTurn({
      workspace: input.cwd,
      provider: input.providerId,
      sessionId: input.sessionId,
      runId: input.turn.runId,
      recordId: archiveCommitted.recordId,
      archiveFingerprint: archiveCommitted.archiveFingerprint,
      providerTurnId: input.providerTurnId,
      userText: input.turn.userText,
      evidence,
      timing: input.timing,
      status: input.status
    })
    if (committed.status !== 'committed' && committed.status !== 'duplicate') {
      throw new Error('reason' in committed ? committed.reason : 'managed recorder canonical commit is still pending')
    }
    await rm(path, { force: true })
    await rm(progressPath(input.userDataDir, input.turn.runId), { force: true })
    return { recorder: 'committed' as const, recordId: committed.recordId }
  })
}

export async function persistManagedTraceProgress(
  input: ManagedTraceTurnCommitInput
): Promise<void> {
  assertManagedTraceInput(input)
  const path = progressPath(input.userDataDir, input.turn.runId)
  const existing = await readJson<ManagedTurnProgress>(path)
  if (existing) {
    if (existing.schemaVersion !== 1) {
      throw new Error(`invalid managed recorder progress for ${input.turn.runId}`)
    }
    assertProgressIdentity(existing, input)
  }
  const { userDataDir: _userDataDir, ...request } = input
  await writeJsonAtomic(path, {
    schemaVersion: 1,
    persistedAt: new Date().toISOString(),
    request
  } satisfies ManagedTurnProgress)
}

export async function recoverManagedTraceProgress(
  userDataDir: string,
  options: { cwd?: string; providerId?: ManagedRecorderProviderId; waitMs?: number } = {}
): Promise<ManagedTurnRecovery> {
  let recovered = 0
  let pending = 0
  const errors: string[] = []
  for (const name of await listFiles(progressRoot(userDataDir))) {
    if (!name.endsWith('.json')) continue
    const path = join(progressRoot(userDataDir), name)
    const progress = await readJson<ManagedTurnProgress>(path)
    if (!progress || progress.schemaVersion !== 1) {
      pending++
      errors.push(`invalid managed turn progress: ${name}`)
      continue
    }
    if (options.cwd && progress.request.cwd !== options.cwd) continue
    if (options.providerId && progress.request.providerId !== options.providerId) continue
    try {
      await commitManagedTraceTurn(
        { ...progress.request, userDataDir },
        { waitMs: options.waitMs ?? 250 }
      )
      recovered++
    } catch (error) {
      pending++
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { recovered, pending, errors }
}

export async function recoverManagedTraceTurns(
  userDataDir: string,
  options: { cwd?: string; providerId?: ManagedRecorderProviderId; waitMs?: number } = {}
): Promise<ManagedTurnRecovery> {
  let recovered = 0
  let pending = 0
  const errors: string[] = []
  for (const name of await listFiles(journalRoot(userDataDir))) {
    if (!name.endsWith('.json')) continue
    const path = join(journalRoot(userDataDir), name)
    const journal = await readJson<ManagedTurnJournal>(path)
    if (!journal || journal.schemaVersion !== 1) {
      pending++
      errors.push(`invalid managed turn journal: ${name}`)
      continue
    }
    if (options.cwd && journal.request.cwd !== options.cwd) continue
    if (options.providerId && journal.request.providerId !== options.providerId) continue
    const result = await withDirectoryLock(
      lockPath(userDataDir, journal.request.turn.runId),
      () => replayJournal(path, userDataDir, journal, options.waitMs ?? 250),
      { waitMs: options.waitMs ?? 250 }
    ).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error))
      return 'pending' as const
    })
    if (result === 'recovered') recovered++
    else {
      pending++
      errors.push(`managed turn ${journal.request.turn.runId} is still pending`)
    }
  }
  return { recovered, pending, errors }
}
