import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ProviderId } from '../shared/provider.js'
import type { RuntimeProvider } from '../shared/runtime.js'
import { listFiles, readJson, writeJsonAtomic } from '../core/turn-recorder/io.js'
import { safeKey, stableHash } from '../core/turn-recorder/store.js'
import {
  findTraceArchiveTurnMatches,
  upsertTraceArchiveTurn,
  type TraceArchiveTurn
} from './transcript-archive.js'

interface TraceTurnProgress {
  schemaVersion: 1
  persistedAt: string
  request: {
    cwd: string
    sessionId: string
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    turn: TraceArchiveTurn
  }
}

const PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode'])
const RUNTIMES = new Set<RuntimeProvider>(['claude_sdk', 'codex_cli', 'qoder_cli', 'opencode_server'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export interface TraceTurnProgressRecovery {
  recovered: number
  pending: number
  errors: string[]
}

function progressRoot(userDataDir: string): string {
  return join(userDataDir, 'trace-turn-progress')
}

function progressPath(userDataDir: string, runId: string): string {
  return join(progressRoot(userDataDir), `${safeKey(runId)}.json`)
}

function validProgress(value: TraceTurnProgress | null): value is TraceTurnProgress {
  const request = value?.request
  const turn = request?.turn
  return value?.schemaVersion === 1 && typeof value.persistedAt === 'string' &&
    typeof request?.cwd === 'string' &&
    typeof request.sessionId === 'string' && request.sessionId.length > 0 &&
    PROVIDERS.has(request.providerId) && RUNTIMES.has(request.runtimeProvider) &&
    Boolean(
      turn && typeof turn.runId === 'string' && turn.runId.length > 0 &&
      typeof turn.userText === 'string' && Array.isArray(turn.items) &&
      turn.items.every((item) => item && typeof item === 'object' && typeof item.kind === 'string' && typeof item.stage === 'string') &&
      turn.done === true && typeof turn.status === 'string' && TERMINAL_STATUSES.has(turn.status) &&
      typeof turn.ts === 'number' && Number.isFinite(turn.ts)
    )
}

function progressIdentity(value: unknown): { cwd: string; sessionId: string; providerId: ProviderId } | null {
  if (!value || typeof value !== 'object') return null
  const request = (value as { request?: unknown }).request
  if (!request || typeof request !== 'object') return null
  const candidate = request as { cwd?: unknown; sessionId?: unknown; providerId?: unknown }
  if (
    typeof candidate.cwd !== 'string' || typeof candidate.sessionId !== 'string' ||
    !PROVIDERS.has(candidate.providerId as ProviderId)
  ) return null
  return { cwd: candidate.cwd, sessionId: candidate.sessionId, providerId: candidate.providerId as ProviderId }
}

function identityMatches(
  identity: { cwd: string; sessionId: string; providerId: ProviderId },
  filter: { cwd?: string; sessionId?: string; providerId?: ProviderId }
): boolean {
  return (filter.cwd == null || identity.cwd === filter.cwd) &&
    (!filter.sessionId || identity.sessionId === filter.sessionId) &&
    (!filter.providerId || identity.providerId === filter.providerId)
}

function baseTurnFingerprint(turn: TraceArchiveTurn): string {
  const { turnEvidence: _turnEvidence, items, ts: _ts, ...base } = turn
  return stableHash({
    ...base,
    items: items.filter((item) => !(item.kind === 'harness' && item.stage === 'turn_diff'))
  })
}

function atomicTempPaths(path: string): string[] {
  const dir = dirname(path)
  const base = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const pattern = new RegExp(`^${base}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`)
  return names.filter((name) => pattern.test(name)).map((name) => join(dir, name))
}

export async function persistTraceTurnProgress(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  turn: TraceArchiveTurn
}): Promise<void> {
  const path = progressPath(args.userDataDir, args.turn.runId)
  const existing = await readJson<TraceTurnProgress>(path)
  const { userDataDir: _userDataDir, ...request } = args
  if (existing) {
    if (!validProgress(existing) || stableHash(existing.request) !== stableHash(request)) {
      throw new Error(`trace turn progress collision for ${args.turn.runId}`)
    }
    return
  }
  await writeJsonAtomic(path, {
    schemaVersion: 1,
    persistedAt: new Date().toISOString(),
    request
  } satisfies TraceTurnProgress)
}

export async function recoverTraceTurnProgress(
  userDataDir: string,
  filter: { cwd?: string; sessionId?: string; providerId?: ProviderId } = {}
): Promise<TraceTurnProgressRecovery> {
  let recovered = 0
  let pending = 0
  const errors: string[] = []
  const scoped = filter.cwd != null || Boolean(filter.sessionId || filter.providerId)
  for (const name of await listFiles(progressRoot(userDataDir))) {
    if (!name.endsWith('.json')) continue
    const path = join(progressRoot(userDataDir), name)
    const progress = await readJson<TraceTurnProgress>(path)
    if (!validProgress(progress)) {
      const identity = progressIdentity(progress)
      if (!scoped || (identity && identityMatches(identity, filter))) {
        pending++
        errors.push(`invalid trace turn progress: ${name}`)
      }
      continue
    }
    const request = progress.request
    if (filter.cwd != null && request.cwd !== filter.cwd) continue
    if (filter.sessionId && request.sessionId !== filter.sessionId) continue
    if (filter.providerId && request.providerId !== filter.providerId) continue
    const existing = findTraceArchiveTurnMatches({
      cwd: request.cwd,
      sessionId: request.sessionId,
      providerId: request.providerId,
      userDataDir,
      runId: request.turn.runId,
      providerTurnId: request.turn.providerTurnId
    }).byRunId
    if (existing) {
      if (baseTurnFingerprint(existing) !== baseTurnFingerprint(request.turn)) {
        pending++
        errors.push(`trace turn progress conflicts with committed archive: ${request.turn.runId}`)
        continue
      }
      await rm(path, { force: true })
      recovered++
      continue
    }
    const ok = upsertTraceArchiveTurn({ ...request, userDataDir })
    if (!ok) {
      pending++
      errors.push(`trace turn progress is still pending: ${request.turn.runId}`)
      continue
    }
    await rm(path, { force: true })
    recovered++
  }
  return { recovered, pending, errors }
}

export async function deleteTraceTurnProgress(userDataDir: string, runId: string): Promise<void> {
  await rm(progressPath(userDataDir, runId), { force: true })
}

export function traceProgressSessionRunIds(
  userDataDir: string,
  identity: { cwd: string; sessionId: string; providerId: ProviderId }
): string[] {
  const runIds = new Set<string>()
  let names: string[]
  try { names = readdirSync(progressRoot(userDataDir)) } catch { return [] }
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const progress = JSON.parse(readFileSync(join(progressRoot(userDataDir), name), 'utf8')) as TraceTurnProgress
      if (
        validProgress(progress) && progress.request.cwd === identity.cwd &&
        progress.request.sessionId === identity.sessionId && progress.request.providerId === identity.providerId
      ) runIds.add(progress.request.turn.runId)
    } catch {
      // Invalid progress cannot safely establish session ownership.
    }
  }
  return [...runIds]
}

export function deleteTraceTurnProgressArtifacts(
  userDataDir: string,
  runIds: ReadonlySet<string>
): { failed: Array<{ path: string; error: string }> } {
  const failed: Array<{ path: string; error: string }> = []
  for (const runId of runIds) {
    const path = progressPath(userDataDir, runId)
    for (const target of [path, ...atomicTempPaths(path)]) {
      try { rmSync(target, { force: true }) } catch (error) {
        failed.push({ path: target, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { failed }
}

export function cleanupTraceTurnProgressTemps(userDataDir: string): void {
  let names: string[]
  const root = progressRoot(userDataDir)
  try { names = readdirSync(root) } catch { return }
  for (const name of names) {
    if (!/\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) continue
    const path = join(root, name)
    try {
      const stat = lstatSync(path)
      if (stat.isFile() && !stat.isSymbolicLink()) rmSync(path, { force: true })
    } catch {
      // Startup cleanup is best-effort; recovery ignores temp files.
    }
  }
}
