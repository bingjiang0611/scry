import { rm } from 'node:fs/promises'
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RuntimeProvider } from '../shared/runtime.js'
import type { ProviderId } from '../shared/provider.js'
import type { AgentTurnRecord } from '../shared/turn-record.js'
import {
  commitManagedRecorderTurn,
  isManagedRecorderProvider,
  isManagedProviderRuntimePair,
  managedRecorderAllowsMissingProviderTurnId,
  managedRecorderMode,
  prepareManagedRecorderTurn,
  type ManagedRecorderProviderId,
  type ManagedTurnTiming
} from '../core/turn-recorder/managed.js'
import { listFiles, readJson, withDirectoryLock, writeJsonAtomic } from '../core/turn-recorder/io.js'
import { safeKey, stableHash } from '../core/turn-recorder/store.js'
import {
  upsertTraceArchiveTurn,
  findTraceArchiveTurnMatches,
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
    providerTurnId?: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validManagedRequest(value: unknown): value is ManagedTurnJournal['request'] {
  if (!isRecord(value) || !isRecord(value.turn) || !isRecord(value.timing)) return false
  const turn = value.turn
  const timing = value.timing
  const validProviderTurnIdentity =
    (typeof value.providerTurnId === 'string' && value.providerTurnId.length > 0 && turn.providerTurnId === value.providerTurnId) ||
    (value.providerTurnId === undefined && turn.providerTurnId === undefined &&
      (value.providerId === 'qoder' || value.providerId === 'opencode') &&
      typeof value.status === 'string' &&
      managedRecorderAllowsMissingProviderTurnId(value.providerId, value.status as AgentTurnRecord['status']))
  return typeof value.cwd === 'string' && value.cwd.length > 0 &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    validProviderTurnIdentity &&
    isManagedProviderRuntimePair(value.providerId, value.runtimeProvider) &&
    typeof turn.runId === 'string' && turn.runId.length > 0 &&
    typeof turn.userText === 'string' &&
    Array.isArray(turn.items) && isRecord(turn.turnEvidence) && turn.done === true &&
    typeof turn.status === 'string' && typeof value.status === 'string' &&
    typeof timing.startedAt === 'string' && typeof timing.completedAt === 'string' &&
    typeof timing.durationMs === 'number' && Number.isFinite(timing.durationMs)
}

function validProgress(value: ManagedTurnProgress | null): value is ManagedTurnProgress {
  return value?.schemaVersion === 1 && typeof value.persistedAt === 'string' && validManagedRequest(value.request)
}

function validJournal(value: ManagedTurnJournal | null): value is ManagedTurnJournal {
  return value?.schemaVersion === 1 &&
    (value.phase === 'prepared' || value.phase === 'archive_committed') &&
    typeof value.archiveFingerprint === 'string' && validManagedRequest(value.request)
}

function managedArtifactIdentity(value: unknown): {
  cwd: string
  sessionId: string
  providerId: ManagedRecorderProviderId
} | null {
  if (!isRecord(value) || !isRecord(value.request)) return null
  const request = value.request
  if (
    typeof request.cwd !== 'string' || typeof request.sessionId !== 'string' ||
    (typeof request.providerId !== 'string' || !isManagedRecorderProvider(request.providerId as ProviderId))
  ) return null
  return {
    cwd: request.cwd,
    sessionId: request.sessionId,
    providerId: request.providerId as ManagedRecorderProviderId
  }
}

function managedIdentityMatches(
  identity: { cwd: string; sessionId: string; providerId: ManagedRecorderProviderId },
  options: { cwd?: string; sessionId?: string; providerId?: ManagedRecorderProviderId }
): boolean {
  return (!options.cwd || identity.cwd === options.cwd) &&
    (!options.sessionId || identity.sessionId === options.sessionId) &&
    (!options.providerId || identity.providerId === options.providerId)
}

export interface ManagedTraceTurnCommitInput {
  userDataDir: string
  cwd: string
  sessionId: string
  providerTurnId?: string
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

export async function managedRecoveryScopes(
  userDataDir: string
): Promise<Array<{ cwd: string; providerId: ManagedRecorderProviderId }>> {
  const scopes = new Map<string, { cwd: string; providerId: ManagedRecorderProviderId }>()
  for (const [root, valid] of [
    [progressRoot(userDataDir), validProgress],
    [journalRoot(userDataDir), validJournal]
  ] as const) {
    for (const name of await listFiles(root)) {
      if (!name.endsWith('.json')) continue
      const value = await readJson<ManagedTurnProgress & ManagedTurnJournal>(join(root, name))
      if (!valid(value)) continue
      const { cwd, providerId } = value.request
      scopes.set(`${providerId}\0${cwd}`, { cwd, providerId })
    }
  }
  return [...scopes.values()]
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

function atomicTempPaths(path: string): string[] {
  const dir = dirname(path)
  const base = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const pattern = new RegExp(`^${base}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`)
  return names.filter((name) => pattern.test(name)).map((name) => join(dir, name))
}

function artifactExists(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export function managedSessionRunIds(
  userDataDir: string,
  identity: { cwd: string; sessionId: string; providerId: ProviderId }
): string[] {
  const runIds = new Set<string>()
  for (const root of [progressRoot(userDataDir), journalRoot(userDataDir)]) {
    let names: string[]
    try { names = readdirSync(root) } catch { continue }
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        const value = JSON.parse(readFileSync(join(root, name), 'utf8')) as {
          schemaVersion?: unknown
          request?: { cwd?: unknown; sessionId?: unknown; providerId?: unknown; turn?: { runId?: unknown } }
        }
        const request = value.request
        if (
          value.schemaVersion === 1 && request?.cwd === identity.cwd &&
          request.sessionId === identity.sessionId && request.providerId === identity.providerId &&
          typeof request.turn?.runId === 'string'
        ) runIds.add(request.turn.runId)
      } catch {
        // An invalid unrelated artifact cannot be attributed to this session.
      }
    }
  }
  return [...runIds]
}

export async function deleteManagedTurnArtifacts(
  userDataDir: string,
  runIds: ReadonlySet<string>
): Promise<{ failed: Array<{ path: string; error: string }> }> {
  const failed: Array<{ path: string; error: string }> = []
  for (const runId of runIds) {
    const lock = lockPath(userDataDir, runId)
    try {
      await withDirectoryLock(lock, async () => {
        const paths = [progressPath(userDataDir, runId), journalPath(userDataDir, runId)]
        for (const path of paths.flatMap((value) => [value, ...atomicTempPaths(value)])) {
          try { rmSync(path, { force: true }) } catch (error) {
            failed.push({ path, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }, { waitMs: 10_000 })
    } catch (error) {
      failed.push({ path: lock, error: error instanceof Error ? error.message : String(error) })
    }
    if (failed.length > 0) {
      // Keep later stores and the catalog intact when any managed artifact is still live.
      break
    }
  }
  return { failed }
}

export function cleanupManagedTurnTemps(userDataDir: string): void {
  for (const root of [progressRoot(userDataDir), journalRoot(userDataDir)]) {
    let names: string[]
    try { names = readdirSync(root) } catch { continue }
    for (const name of names) {
      if (!/\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) continue
      const path = join(root, name)
      try {
        const stat = lstatSync(path)
        if (stat.isFile() && !stat.isSymbolicLink()) rmSync(path, { force: true })
      } catch {
        // Startup cleanup is best-effort; recovery will still ignore temp files.
      }
    }
  }
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

function baseTurnFingerprint(turn: TraceArchiveTurn): string {
  const { turnEvidence: _turnEvidence, items, ts: _ts, ...base } = turn
  return stableHash({
    ...base,
    items: items.filter((item) => !(item.kind === 'harness' && item.stage === 'turn_diff'))
  })
}

function turnDiffCount(turn: TraceArchiveTurn): number {
  return turn.items.filter((item) => item.kind === 'harness' && item.stage === 'turn_diff').length
}

function turnContentFingerprint(turn: TraceArchiveTurn): string {
  const { ts: _ts, ...content } = turn
  return stableHash(content)
}

function existingTurnDisposition(
  existing: TraceArchiveTurn,
  incoming: TraceArchiveTurn
): 'existing_dominates' | 'incoming_enriches' | 'conflict' {
  if (baseTurnFingerprint(existing) !== baseTurnFingerprint(incoming)) return 'conflict'
  if (turnContentFingerprint(existing) === turnContentFingerprint(incoming)) return 'existing_dominates'
  const existingDiffs = turnDiffCount(existing)
  const incomingDiffs = turnDiffCount(incoming)
  if (existingDiffs > incomingDiffs) return 'existing_dominates'
  if (incomingDiffs > existingDiffs) return 'incoming_enriches'
  return 'conflict'
}

function matchingArchiveTurn(input: ManagedTraceTurnCommitInput): TraceArchiveTurn | undefined {
  const matches = findTraceArchiveTurnMatches({
    cwd: input.cwd,
    sessionId: input.sessionId,
    providerId: input.providerId,
    userDataDir: input.userDataDir,
    runId: input.turn.runId,
    providerTurnId: input.providerTurnId
  })
  if (
    matches.byRunId && matches.byProviderTurnId &&
    stableHash(matches.byRunId) !== stableHash(matches.byProviderTurnId)
  ) throw new Error(`managed recorder archive identity collision for ${input.turn.runId}`)
  return matches.byProviderTurnId ?? matches.byRunId
}

function assertManagedTraceInput(input: ManagedTraceTurnCommitInput): void {
  if (!isManagedProviderRuntimePair(input.providerId, input.runtimeProvider)) {
    throw new Error('managed recorder Provider id differs from runtime provider')
  }
  const permitsMissingProviderTurnId =
    !input.providerTurnId && !input.turn.providerTurnId && (
      managedRecorderAllowsMissingProviderTurnId(input.providerId, input.status)
    )
  if (!permitsMissingProviderTurnId && (!input.providerTurnId || input.turn.providerTurnId !== input.providerTurnId)) {
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
  const existing = findTraceArchiveTurnMatches({
    cwd: request.cwd,
    sessionId: request.sessionId,
    providerId: request.providerId,
    userDataDir,
    runId: request.turn.runId,
    providerTurnId: request.providerTurnId
  })
  const providerExisting = existing.byProviderTurnId
  if (providerExisting) {
    if (providerTurnFingerprint(providerExisting) !== providerTurnFingerprint(request.turn)) {
      throw new Error(`managed recorder Provider turn collision for ${request.providerTurnId}`)
    }
    return
  }
  if (existing.byRunId && stableHash(existing.byRunId) !== stableHash(request.turn)) {
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
  waitMs: number,
  commitHookEnv?: NodeJS.ProcessEnv
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
      status: archiveCommitted.request.status,
      env: commitHookEnv
    })
    if (committed.status === 'disabled' || committed.status === 'pending' || committed.status === 'prepared') {
      throw new Error('reason' in committed ? committed.reason : 'managed recorder canonical commit is still pending')
    }
    await rm(progressPath(userDataDir, journal.request.turn.runId), { force: true })
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
  const observedTiming = (() => {
    if (!observed) return null
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
  })()

  // A Claude query may continue after intermediate SDK result messages. The
  // latest result duration then covers only that continuation, while the App
  // boundary covers the complete user query.
  if (providerId === 'claude' && observedTiming) return observedTiming
  const canonical = canonicalTurnTiming(events)
  if (canonical) return canonical
  if ((providerId === 'qoder' || providerId === 'opencode') && status !== 'completed') return observedTiming
  return null
}

export async function commitManagedTraceTurn(
  input: ManagedTraceTurnCommitInput,
  options: {
    waitMs?: number
    removeArtifact?: (path: string) => Promise<void>
    commitHookEnv?: NodeJS.ProcessEnv
  } = {}
): Promise<{ recorder: 'disabled' | 'committed'; recordId?: string }> {
  const mode = await managedRecorderMode(input.cwd, options.commitHookEnv)
  if (mode.status === 'disabled') {
    const existing = matchingArchiveTurn(input)
    if (existing) {
      const disposition = existingTurnDisposition(existing, input.turn)
      if (disposition === 'conflict') {
        throw new Error(`managed recorder progress conflicts with committed archive: ${input.turn.runId}`)
      }
      if (disposition === 'existing_dominates') {
        await rm(progressPath(input.userDataDir, input.turn.runId), { force: true })
        return { recorder: 'disabled' }
      }
    }
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
  assertManagedTraceInput(input)

  const path = journalPath(input.userDataDir, input.turn.runId)
  const removeArtifact = options.removeArtifact ?? ((target: string) => rm(target, { force: true }))
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
      status: input.status,
      env: options.commitHookEnv
    })
    if (committed.status !== 'committed' && committed.status !== 'duplicate') {
      throw new Error('reason' in committed ? committed.reason : 'managed recorder canonical commit is still pending')
    }
    await removeArtifact(progressPath(input.userDataDir, input.turn.runId))
    await removeArtifact(path)
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
  options: {
    cwd?: string
    sessionId?: string
    providerId?: ManagedRecorderProviderId
    waitMs?: number
    commitHookEnv?: NodeJS.ProcessEnv
  } = {}
): Promise<ManagedTurnRecovery> {
  let recovered = 0
  let pending = 0
  const errors: string[] = []
  const scoped = Boolean(options.cwd || options.sessionId || options.providerId)
  for (const name of await listFiles(progressRoot(userDataDir))) {
    if (!name.endsWith('.json')) continue
    const path = join(progressRoot(userDataDir), name)
    const progress = await readJson<ManagedTurnProgress>(path)
    if (!validProgress(progress)) {
      const identity = managedArtifactIdentity(progress)
      if (!scoped || (identity && managedIdentityMatches(identity, options))) {
        pending++
        errors.push(`invalid managed turn progress: ${name}`)
      }
      continue
    }
    if (options.cwd && progress.request.cwd !== options.cwd) continue
    if (options.sessionId && progress.request.sessionId !== options.sessionId) continue
    if (options.providerId && progress.request.providerId !== options.providerId) continue
    try {
      const canonicalJournalPath = journalPath(userDataDir, progress.request.turn.runId)
      const journal = await readJson<ManagedTurnJournal>(canonicalJournalPath)
      if (journal || artifactExists(canonicalJournalPath)) {
        pending++
        errors.push(`managed turn ${progress.request.turn.runId} has a canonical journal that must recover first`)
        continue
      }
      const input = { ...progress.request, userDataDir }
      assertManagedTraceInput(input)
      const existing = matchingArchiveTurn(input)
      if (existing) {
        const disposition = existingTurnDisposition(existing, progress.request.turn)
        if (disposition === 'conflict') {
          throw new Error(`managed recorder progress conflicts with committed archive: ${progress.request.turn.runId}`)
        }
        if (disposition === 'existing_dominates') {
          await rm(path, { force: true })
          recovered++
          continue
        }
      }
      await commitManagedTraceTurn(
        input,
        { waitMs: options.waitMs ?? 250, commitHookEnv: options.commitHookEnv }
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
  options: {
    cwd?: string
    sessionId?: string
    providerId?: ManagedRecorderProviderId
    waitMs?: number
    commitHookEnv?: NodeJS.ProcessEnv
  } = {}
): Promise<ManagedTurnRecovery> {
  let recovered = 0
  let pending = 0
  const errors: string[] = []
  const scoped = Boolean(options.cwd || options.sessionId || options.providerId)
  for (const name of await listFiles(journalRoot(userDataDir))) {
    if (!name.endsWith('.json')) continue
    const path = join(journalRoot(userDataDir), name)
    const journal = await readJson<ManagedTurnJournal>(path)
    if (!validJournal(journal)) {
      const identity = managedArtifactIdentity(journal)
      if (!scoped || (identity && managedIdentityMatches(identity, options))) {
        pending++
        errors.push(`invalid managed turn journal: ${name}`)
      }
      continue
    }
    if (options.cwd && journal.request.cwd !== options.cwd) continue
    if (options.sessionId && journal.request.sessionId !== options.sessionId) continue
    if (options.providerId && journal.request.providerId !== options.providerId) continue
    const result = await withDirectoryLock(
      lockPath(userDataDir, journal.request.turn.runId),
      () => replayJournal(path, userDataDir, journal, options.waitMs ?? 250, options.commitHookEnv),
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
