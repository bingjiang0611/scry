import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDiffSnapshotStage, normalizeTurnDiffSnapshot } from '../shared/trace'
import { providerIdForRuntime, type RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import {
  type TraceArchive,
  type TraceArchiveTurn,
  traceArchivePath,
  traceArchiveTurnDir,
  traceArchiveTurnPath,
  trustedOwnedParent
} from './transcript-archive-paths'

export type ArchiveInspection =
  | { status: 'missing' }
  | { status: 'invalid'; reason: 'untrusted' | 'corrupt' | 'identity_mismatch' | 'provider_mismatch'; error: string }
  | { status: 'valid'; archive: TraceArchive }

const PROVIDER_IDS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi', 'antigravity'])
const RUNTIME_PROVIDERS = new Set<RuntimeProvider>(['claude_sdk', 'codex_cli', 'qoder_cli', 'opencode_server', 'pi_rpc', 'antigravity_acp'])

function isArchiveShape(value: unknown): value is TraceArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const archive = value as Partial<TraceArchive>
  if (
    archive.version !== 3 ||
    typeof archive.cwd !== 'string' ||
    typeof archive.sessionId !== 'string' ||
    !Array.isArray(archive.turns)
  ) return false
  return archive.turns.every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const turn = raw as Partial<TraceArchiveTurn>
    return typeof turn.runId === 'string' && turn.runId.length > 0 &&
      (turn.providerTurnId == null || typeof turn.providerTurnId === 'string') &&
      (turn.forkTurnId == null || typeof turn.forkTurnId === 'string') &&
      typeof turn.userText === 'string' &&
      Array.isArray(turn.items) && turn.items.every((item) => !!item && typeof item === 'object' && !Array.isArray(item)) &&
      (turn.attachments == null || (Array.isArray(turn.attachments) && turn.attachments.every(
        (attachment) => !!attachment && typeof attachment === 'object' && !Array.isArray(attachment)
      ))) &&
      typeof turn.done === 'boolean' &&
      typeof turn.ts === 'number' && Number.isFinite(turn.ts)
  })
}

function archiveProviderIdentities(archive: TraceArchive): { ids: Set<ProviderId>; invalid: boolean } {
  const ids = new Set<ProviderId>()
  let invalid = false
  const collect = (providerId: unknown, runtimeProvider: unknown): void => {
    if (providerId !== undefined) {
      if (typeof providerId === 'string' && PROVIDER_IDS.has(providerId as ProviderId)) ids.add(providerId as ProviderId)
      else invalid = true
    }
    if (runtimeProvider !== undefined) {
      if (typeof runtimeProvider === 'string' && RUNTIME_PROVIDERS.has(runtimeProvider as RuntimeProvider)) {
        ids.add(providerIdForRuntime(runtimeProvider as RuntimeProvider))
      } else invalid = true
    }
  }
  collect(archive.providerId, archive.runtimeProvider)
  for (const turn of archive.turns) {
    if (!Array.isArray(turn.items)) continue
    for (const item of turn.items) collect(item.providerId, item.runtimeProvider)
  }
  return { ids, invalid }
}

function normalizeArchive(archive: TraceArchive): TraceArchive {
  archive.turns = archive.turns.map((turn) => ({
    ...turn,
    items: Array.isArray(turn.items)
      ? turn.items.map((event) => {
          if (!isDiffSnapshotStage(event.stage)) return event
          const turnDiff = normalizeTurnDiffSnapshot(event.turnDiff)
          return {
            ...event,
            turnDiff:
              turnDiff ??
              {
                version: 1,
                status: 'failed',
                reason: 'git_error',
                files: [],
                beforeAt: event.ts,
                afterAt: event.ts,
                captureMs: 0,
                cleanup: 'failed'
              }
          }
        })
      : []
  }))
  return archive
}

export function validateArchive(
  value: unknown,
  cwd: string,
  sessionId: string,
  expectedProvider?: ProviderId
): ArchiveInspection {
  if (!isArchiveShape(value)) return { status: 'invalid', reason: 'corrupt', error: 'archive schema is invalid' }
  if (value.cwd !== cwd || value.sessionId !== sessionId) {
    return { status: 'invalid', reason: 'identity_mismatch', error: 'archive belongs to another session/cwd' }
  }
  const identities = archiveProviderIdentities(value)
  if (identities.invalid || identities.ids.size > 1 || (expectedProvider && (identities.ids.size !== 1 || !identities.ids.has(expectedProvider)))) {
    return { status: 'invalid', reason: 'provider_mismatch', error: 'archive contains conflicting Provider identity' }
  }
  return { status: 'valid', archive: normalizeArchive(value) }
}

export function inspectArchiveFile(
  userDataDir: string,
  fp: string,
  cwd: string,
  sessionId: string,
  expectedProvider?: ProviderId
): ArchiveInspection {
  try {
    trustedOwnedParent(userDataDir, fp, false)
    const stat = lstatSync(fp)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'invalid', reason: 'untrusted', error: 'archive is not a trusted regular file' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', reason: 'untrusted', error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return validateArchive(JSON.parse(readFileSync(fp, 'utf8')), cwd, sessionId, expectedProvider)
  } catch (error) {
    return { status: 'invalid', reason: 'corrupt', error: `archive is corrupt: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function inspectArchiveFileAsync(
  userDataDir: string,
  fp: string,
  cwd: string,
  sessionId: string,
  expectedProvider?: ProviderId,
  signal?: AbortSignal
): Promise<ArchiveInspection> {
  signal?.throwIfAborted()
  try {
    trustedOwnedParent(userDataDir, fp, false)
    const stat = await lstat(fp)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'invalid', reason: 'untrusted', error: 'archive is not a trusted regular file' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', reason: 'untrusted', error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return validateArchive(JSON.parse(await readFile(fp, { encoding: 'utf8', signal })), cwd, sessionId, expectedProvider)
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return { status: 'invalid', reason: 'corrupt', error: `archive is corrupt: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export type SegmentedArchiveInspection = {
  valid: TraceArchive[]
  invalid: Array<{ path: string; error: string }>
}

export function inspectSegmentedArchives(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): SegmentedArchiveInspection {
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  let names: string[]
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    names = readdirSync(dir).filter((name) => /^turn-[a-f0-9]{64}\.json$/.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { valid: [], invalid: [] }
    return { valid: [], invalid: [{ path: dir, error: error instanceof Error ? error.message : String(error) }] }
  }
  const valid: TraceArchive[] = []
  const invalid: Array<{ path: string; error: string }> = []
  for (const name of names) {
    const path = join(dir, name)
    const inspected = inspectArchiveFile(
      args.userDataDir,
      path,
      args.cwd,
      args.sessionId,
      args.providerId
    )
    if (inspected.status !== 'valid') {
      invalid.push({
        path,
        error: inspected.status === 'invalid' ? inspected.error : 'segmented archive disappeared'
      })
      continue
    }
    if (
      inspected.archive.turns.length !== 1 ||
      traceArchiveTurnPath(
        args.userDataDir,
        args.cwd,
        args.sessionId,
        args.providerId,
        inspected.archive.turns[0]
      ) !== path
    ) {
      invalid.push({ path, error: 'segmented archive identity is invalid' })
      continue
    }
    valid.push(inspected.archive)
  }
  return { valid, invalid }
}

export async function inspectSegmentedArchivesAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, signal?: AbortSignal): Promise<SegmentedArchiveInspection> {
  signal?.throwIfAborted()
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  let names: string[]
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    names = (await readdir(dir)).filter((name) => /^turn-[a-f0-9]{64}\.json$/.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { valid: [], invalid: [] }
    return { valid: [], invalid: [{ path: dir, error: error instanceof Error ? error.message : String(error) }] }
  }
  const valid: TraceArchive[] = []
  const invalid: Array<{ path: string; error: string }> = []
  const concurrency = 8
  for (let offset = 0; offset < names.length; offset += concurrency) {
    signal?.throwIfAborted()
    const batch = await Promise.all(names.slice(offset, offset + concurrency).map(async (name) => {
      const path = join(dir, name)
      const inspected = await inspectArchiveFileAsync(args.userDataDir, path, args.cwd, args.sessionId, args.providerId, signal)
      return { path, inspected }
    }))
    for (const { path, inspected } of batch) {
      if (inspected.status !== 'valid') {
        invalid.push({ path, error: inspected.status === 'invalid' ? inspected.error : 'segmented archive disappeared' })
        continue
      }
      if (
        inspected.archive.turns.length !== 1 ||
        traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, inspected.archive.turns[0]) !== path
      ) {
        invalid.push({ path, error: 'segmented archive identity is invalid' })
        continue
      }
      valid.push(inspected.archive)
    }
  }
  return { valid, invalid }
}

export function mergeArchives(archives: TraceArchive[]): TraceArchive | null {
  if (archives.length === 0) return null
  const turns = new Map<string, TraceArchiveTurn>()
  for (const archive of archives) {
    for (const turn of archive.turns) if (turn.runId) turns.set(turn.runId, turn)
  }
  const newest = archives[archives.length - 1]
  return {
    ...newest,
    turns: [...turns.values()].sort((a, b) => a.ts - b.ts)
  }
}

export function archiveCandidates(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): TraceArchive[] {
  const current = inspectArchiveFile(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId
  )
  return (current.status === 'valid' ? [current.archive] : []).concat(inspectSegmentedArchives(args).valid)
}
