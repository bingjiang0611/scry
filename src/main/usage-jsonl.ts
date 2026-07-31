import { appendFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProviderId, SessionProviderId } from '../shared/provider'
import type { RuntimeProvider } from '../shared/runtime'
import type { UsageStats } from '../shared/trace'

export interface UsageResultEvent {
  costUsd?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  ts: string
}

export type { UsageStats } from '../shared/trace'

export const usageJsonlPath = (userDataDir: string): string => join(userDataDir, 'usage.jsonl')

function cleanupAtomicTemps(file: string): void {
  const dir = dirname(file)
  const base = basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  const pattern = new RegExp(`^${base}(?:\\.tmp|\\.\\d+\\.[0-9a-f-]{36}\\.tmp)$`)
  for (const name of entries) {
    if (!pattern.test(name)) continue
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path)
    } catch {
      // Another cleanup/write may have won the race.
    }
  }
}

function writeUsageAtomic(file: string, source: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, source)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* temp may already have been renamed */ }
    throw error
  }
}

export function cleanupUsageAtomicTemps(userDataDir: string): void {
  cleanupAtomicTemps(usageJsonlPath(userDataDir))
}

export function appendUsage(
  userDataDir: string,
  context: {
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    cwd?: string
    externalSessionId?: string
    runId?: string
    source?: string
  },
  ev: UsageResultEvent
): void {
  try {
    const row = {
      providerId: context.providerId,
      runtimeProvider: context.runtimeProvider,
      cwd: context.cwd ?? '',
      externalSessionId: context.externalSessionId ?? null,
      runId: context.runId ?? null,
      source: context.source ?? null,
      cost: ev.costUsd ?? null,
      tin: ev.tokensIn ?? null,
      tout: ev.tokensOut ?? null,
      ts: ev.ts
    }
    appendFileSync(usageJsonlPath(userDataDir), JSON.stringify(row) + '\n')
  } catch {
    /* usage.jsonl is best-effort; sqlite remains the structured source */
  }
}

export function readUsageStats(
  userDataDir: string,
  filter: { providerId?: SessionProviderId; cwd?: string } = {}
): UsageStats {
  let cost = 0
  let tin = 0
  let tout = 0
  let costRows = 0
  let tinRows = 0
  let toutRows = 0
  let turns = 0
  let parsedLines = 0
  let invalidLines = 0
  let source: string
  try {
    source = readFileSync(usageJsonlPath(userDataDir), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'ready', cost: null, tin: null, tout: null, turns: 0, invalidLines: 0 }
    return {
      status: 'unavailable',
      cost: null,
      tin: null,
      tout: null,
      turns: 0,
      invalidLines: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  for (const line of source.split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line) as {
          providerId?: SessionProviderId
          cwd?: string
          cost?: number | null
          tin?: number | null
          tout?: number | null
        }
        parsedLines++
        const providerId = o.providerId ?? 'legacy_unknown'
        if (filter.providerId && providerId !== filter.providerId) continue
        if (filter.cwd && o.cwd !== filter.cwd) continue
        if (typeof o.cost === 'number') {
          cost += o.cost
          costRows++
        }
        if (typeof o.tin === 'number') {
          tin += o.tin
          tinRows++
        }
        if (typeof o.tout === 'number') {
          tout += o.tout
          toutRows++
        }
        turns++
      } catch {
        invalidLines++
      }
  }
  return {
    status: invalidLines === 0 ? 'ready' : parsedLines === 0 ? 'query_error' : 'partial',
    cost: costRows ? cost : null,
    tin: tinRows ? tin : null,
    tout: toutRows ? tout : null,
    turns,
    invalidLines,
    ...(invalidLines > 0 ? { error: `${invalidLines} 行 usage 记录无法解析` } : {})
  }
}

export function deleteUsageSessionRows(args: {
  userDataDir: string
  providerId: SessionProviderId
  cwd: string
  externalSessionId: string
  runIds: ReadonlySet<string>
}): { removed: number; preservedInvalid: number } {
  const file = usageJsonlPath(args.userDataDir)
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, preservedInvalid: 0 }
    throw error
  }
  let removed = 0
  let preservedInvalid = 0
  const kept = source.split('\n').filter((line) => {
    if (!line.trim()) return true
    try {
      const row = JSON.parse(line) as {
        providerId?: SessionProviderId
        cwd?: string
        externalSessionId?: string | null
        runId?: string | null
      }
      const identityMatch =
        (row.providerId ?? 'legacy_unknown') === args.providerId &&
        row.cwd === args.cwd &&
        row.externalSessionId === args.externalSessionId
      const hasCompleteIdentity =
        typeof row.providerId === 'string' &&
        typeof row.cwd === 'string' &&
        typeof row.externalSessionId === 'string'
      // A run id only recovers unattributed legacy rows. Never let a corrupt archive runId
      // override a complete, different session identity.
      const legacyScopeMatch =
        !hasCompleteIdentity &&
        row.providerId === args.providerId &&
        row.cwd === args.cwd &&
        row.externalSessionId == null
      const runMatch = legacyScopeMatch && typeof row.runId === 'string' && args.runIds.has(row.runId)
      if (identityMatch || runMatch) {
        removed++
        return false
      }
      return true
    } catch {
      preservedInvalid++
      return true
    }
  })
  if (removed > 0) writeUsageAtomic(file, kept.join('\n'))
  return { removed, preservedInvalid }
}

export function usageSessionRunIds(args: {
  userDataDir: string
  providerId: SessionProviderId
  cwd: string
  externalSessionId: string
}): string[] {
  let source: string
  try {
    source = readFileSync(usageJsonlPath(args.userDataDir), 'utf8')
  } catch {
    return []
  }
  const runIds = new Set<string>()
  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as {
        providerId?: unknown
        cwd?: unknown
        externalSessionId?: unknown
        runId?: unknown
      }
      if (
        row.providerId === args.providerId && row.cwd === args.cwd &&
        row.externalSessionId === args.externalSessionId && typeof row.runId === 'string' && row.runId
      ) runIds.add(row.runId)
    } catch {
      // Corrupt rows are retained and cannot safely establish ownership.
    }
  }
  return [...runIds]
}
