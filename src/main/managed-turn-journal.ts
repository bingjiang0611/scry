// Managed turn journal/progress artifacts in userData: their shapes, validation, paths and
// lifecycle (read, sidecar state, session attribution, deletion, temp cleanup). The commit
// protocol that drives them lives in managed-turn-commit.ts.

import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RuntimeProvider } from '../shared/runtime.js'
import type { ProviderId } from '../shared/provider.js'
import type { AgentTurnRecord } from '../shared/turn-record.js'
import {
  isManagedRecorderProvider,
  isManagedProviderRuntimePair,
  managedRecorderAllowsMissingProviderTurnId,
  type ManagedRecorderProviderId,
  type ManagedTurnTiming
} from '../core/turn-recorder/managed.js'
import { listFiles, readJson, withDirectoryLock, writeJsonAtomic } from '../core/turn-recorder/io.js'
import { safeKey } from '../core/turn-recorder/store.js'
import type { TraceArchiveTurn } from './transcript-archive.js'

export interface ManagedTurnJournal {
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

export interface ManagedTurnProgress {
  schemaVersion: 1
  persistedAt: string
  request: Omit<ManagedTraceTurnCommitInput, 'userDataDir'>
}

export interface ManagedTurnJournalState {
  schemaVersion: 1
  phase: ManagedTurnJournal['phase']
  archiveFingerprint: string
  recordId?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validManagedRequest(value: unknown): value is ManagedTurnJournal['request'] {
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

export function validProgress(value: ManagedTurnProgress | null): value is ManagedTurnProgress {
  return value?.schemaVersion === 1 && typeof value.persistedAt === 'string' && validManagedRequest(value.request)
}

export function validJournal(value: ManagedTurnJournal | null): value is ManagedTurnJournal {
  return value?.schemaVersion === 1 &&
    (value.phase === 'prepared' || value.phase === 'archive_committed') &&
    typeof value.archiveFingerprint === 'string' && validManagedRequest(value.request)
}

export function validJournalState(
  value: ManagedTurnJournalState | null,
  journal: ManagedTurnJournal
): value is ManagedTurnJournalState {
  return value?.schemaVersion === 1 &&
    (value.phase === 'prepared' || value.phase === 'archive_committed') &&
    typeof value.archiveFingerprint === 'string' &&
    value.archiveFingerprint === journal.archiveFingerprint &&
    (value.recordId === undefined || (typeof value.recordId === 'string' && value.recordId.length > 0)) &&
    (value.phase !== 'archive_committed' || value.recordId !== undefined)
}

export function normalizeJournal(
  journal: ManagedTurnJournal | null,
  state: ManagedTurnJournalState | null
): ManagedTurnJournal | null {
  // Preserve malformed intents so scoped recovery can attribute and report them, and a
  // new commit cannot mistake an existing corrupt artifact for an absent journal.
  if (!validJournal(journal)) return journal
  // The v1 journal remains the immutable intent and is a complete recovery fallback. A
  // malformed, stale, or missing sidecar is disposable and must never authorize a new phase.
  if (!validJournalState(state, journal)) return journal
  return {
    ...journal,
    phase: state.phase,
    ...(state.recordId ? { recordId: state.recordId } : {})
  }
}

export function managedArtifactIdentity(value: unknown): {
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

export function managedIdentityMatches(
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

export function journalRoot(userDataDir: string): string {
  return join(userDataDir, 'managed-turn-commits')
}

export function journalStateRoot(userDataDir: string): string {
  return join(userDataDir, 'managed-turn-journal-state')
}

export function progressRoot(userDataDir: string): string {
  return join(userDataDir, 'managed-turn-progress')
}

export function progressPath(userDataDir: string, runId: string): string {
  return join(progressRoot(userDataDir), `${safeKey(runId)}.json`)
}

export function journalPath(userDataDir: string, runId: string): string {
  return join(journalRoot(userDataDir), `${safeKey(runId)}.json`)
}

export function journalStatePath(userDataDir: string, runId: string): string {
  return join(journalStateRoot(userDataDir), `${safeKey(runId)}.json`)
}

export function lockPath(userDataDir: string, runId: string): string {
  return join(journalRoot(userDataDir), 'locks', `${safeKey(runId)}.lock`)
}

export async function readManagedJournalAt(
  journalFile: string,
  stateFile: string
): Promise<ManagedTurnJournal | null> {
  const journal = await readJson<ManagedTurnJournal>(journalFile)
  const state = journal ? await readJson<ManagedTurnJournalState>(stateFile) : null
  return normalizeJournal(journal, state)
}

export async function readManagedJournal(userDataDir: string, runId: string): Promise<ManagedTurnJournal | null> {
  return readManagedJournalAt(journalPath(userDataDir, runId), journalStatePath(userDataDir, runId))
}

export async function writeJournalState(
  userDataDir: string,
  journal: ManagedTurnJournal
): Promise<void> {
  await writeJsonAtomic(journalStatePath(userDataDir, journal.request.turn.runId), {
    schemaVersion: 1,
    phase: journal.phase,
    archiveFingerprint: journal.archiveFingerprint,
    ...(journal.recordId ? { recordId: journal.recordId } : {})
  } satisfies ManagedTurnJournalState)
}

export function atomicTempPaths(path: string): string[] {
  const dir = dirname(path)
  const base = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const pattern = new RegExp(`^${base}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`)
  return names.filter((name) => pattern.test(name)).map((name) => join(dir, name))
}

export function artifactExists(path: string): boolean {
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
        const paths = [
          progressPath(userDataDir, runId),
          journalPath(userDataDir, runId),
          journalStatePath(userDataDir, runId)
        ]
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
  for (const root of [progressRoot(userDataDir), journalRoot(userDataDir), journalStateRoot(userDataDir)]) {
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

