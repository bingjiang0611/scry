import { appendFileSync, chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LlmPerformanceHistoryRow } from '../shared/llm-performance'
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

interface ParsedUsageRow {
  providerId: SessionProviderId
  agentProfileId?: string | null
  cwd?: string
  cost?: number | null
  tin?: number | null
  tout?: number | null
}

interface UsageAggregate {
  providerId: SessionProviderId
  agentProfileId?: string | null
  cwd: string
  cost: number
  tin: number
  tout: number
  costRows: number
  tinRows: number
  toutRows: number
  turns: number
}

let usageScanCache: {
  file: string
  size: number
  mtimeMs: number
  ctimeMs: number
  dev: number
  ino: number
  endsWithNewline: boolean
  aggregates: Map<string, UsageAggregate>
  invalidLines: number
} | null = null

function invalidateUsageScan(file: string): void {
  if (usageScanCache?.file === file) usageScanCache = null
}

const aggregateKey = (row: Pick<ParsedUsageRow, 'providerId' | 'agentProfileId' | 'cwd'>): string =>
  `${row.providerId}\0${row.agentProfileId ?? ''}\0${row.cwd ?? ''}`

function addAggregate(aggregates: Map<string, UsageAggregate>, row: ParsedUsageRow): void {
  const key = aggregateKey(row)
  const aggregate = aggregates.get(key) ?? {
    providerId: row.providerId,
    agentProfileId: row.agentProfileId,
    cwd: row.cwd ?? '',
    cost: 0,
    tin: 0,
    tout: 0,
    costRows: 0,
    tinRows: 0,
    toutRows: 0,
    turns: 0
  }
  if (typeof row.cost === 'number') { aggregate.cost += row.cost; aggregate.costRows++ }
  if (typeof row.tin === 'number') { aggregate.tin += row.tin; aggregate.tinRows++ }
  if (typeof row.tout === 'number') { aggregate.tout += row.tout; aggregate.toutRows++ }
  aggregate.turns++
  aggregates.set(key, aggregate)
}

function scanUsage(file: string): { aggregates: Map<string, UsageAggregate>; invalidLines: number; sourceBytes: number } {
  const stat = statSync(file)
  if (usageScanCache?.file === file && usageScanCache.size === stat.size && usageScanCache.mtimeMs === stat.mtimeMs &&
    usageScanCache.ctimeMs === stat.ctimeMs && usageScanCache.dev === stat.dev && usageScanCache.ino === stat.ino) {
    return { aggregates: usageScanCache.aggregates, invalidLines: usageScanCache.invalidLines, sourceBytes: stat.size }
  }
  const aggregates = new Map<string, UsageAggregate>()
  let invalidLines = 0
  const source = readFileSync(file, 'utf8')
  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Omit<ParsedUsageRow, 'providerId'> & { providerId?: SessionProviderId; kind?: string }
      if (parsed.kind === 'llm_performance') continue
      addAggregate(aggregates, { ...parsed, providerId: parsed.providerId ?? 'legacy_unknown' })
    } catch {
      invalidLines++
    }
  }
  usageScanCache = { file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    dev: stat.dev, ino: stat.ino, endsWithNewline: source.length === 0 || source.endsWith('\n'), aggregates, invalidLines }
  return { aggregates, invalidLines, sourceBytes: stat.size }
}

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
    invalidateUsageScan(file)
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
    agentProfileId?: string
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
      agentProfileId: context.agentProfileId ?? null,
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
    const file = usageJsonlPath(userDataDir)
    const line = `${JSON.stringify(row)}\n`
    const previousSize = usageScanCache?.file === file ? usageScanCache.size : undefined
    appendFileSync(file, line, { mode: 0o600 })
    chmodSync(file, 0o600)
    const stat = statSync(file)
    if (usageScanCache?.file === file && usageScanCache.endsWithNewline && previousSize != null && previousSize + Buffer.byteLength(line) === stat.size) {
      addAggregate(usageScanCache.aggregates, row)
      usageScanCache.size = stat.size
      usageScanCache.mtimeMs = stat.mtimeMs
      usageScanCache.ctimeMs = stat.ctimeMs
      usageScanCache.dev = stat.dev
      usageScanCache.ino = stat.ino
    } else invalidateUsageScan(file)
  } catch {
    /* usage.jsonl is best-effort; sqlite remains the structured source */
  }
}

/** Telemetry shares usage ownership/deletion, but must never count as a billing turn. */
export async function appendLlmPerformance(
  userDataDir: string,
  context: { cwd: string; externalSessionId?: string },
  sample: LlmPerformanceHistoryRow
): Promise<void> {
  const file = usageJsonlPath(userDataDir)
  const line = `${JSON.stringify({
    kind: 'llm_performance', providerId: sample.providerId, agentProfileId: sample.agentProfileId ?? null,
    cwd: context.cwd, externalSessionId: context.externalSessionId ?? null, runId: sample.runId,
    ts: sample.ts, performanceSample: sample
  })}\n`
  const handle = await open(file, 'a', 0o600)
  try {
    const before = await handle.stat()
    await handle.appendFile(line, 'utf8')
    await handle.chmod(0o600)
    const after = await handle.stat()
    const cache = usageScanCache
    // Telemetry has no billing contribution. Advance only a cache matching the exact pre-append
    // file; external edits/replacements or concurrent writers force the ordinary authoritative scan.
    if (cache?.file === file && cache.endsWithNewline && cache.dev === before.dev && cache.ino === before.ino &&
      cache.size === before.size && cache.mtimeMs === before.mtimeMs && cache.ctimeMs === before.ctimeMs &&
      after.dev === before.dev && after.ino === before.ino && after.size === before.size + Buffer.byteLength(line)) {
      cache.size = after.size
      cache.mtimeMs = after.mtimeMs
      cache.ctimeMs = after.ctimeMs
    } else invalidateUsageScan(file)
  } finally {
    await handle.close()
  }
}

export function readUsageStats(
  userDataDir: string,
  filter: { providerId?: SessionProviderId; agentProfileId?: string; cwd?: string } = {}
): UsageStats {
  let cost = 0
  let tin = 0
  let tout = 0
  let costRows = 0
  let tinRows = 0
  let toutRows = 0
  let turns = 0
  let scan: ReturnType<typeof scanUsage>
  try {
    scan = scanUsage(usageJsonlPath(userDataDir))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'ready', cost: null, tin: null, tout: null, turns: 0, invalidLines: 0, sourceBytes: 0 }
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
  for (const row of scan.aggregates.values()) {
    if (filter.providerId && row.providerId !== filter.providerId) continue
    if (filter.agentProfileId !== undefined && row.agentProfileId !== filter.agentProfileId) continue
    if (filter.cwd != null && row.cwd !== filter.cwd) continue
    cost += row.cost
    tin += row.tin
    tout += row.tout
    costRows += row.costRows
    tinRows += row.tinRows
    toutRows += row.toutRows
    turns += row.turns
  }
  return {
    status: scan.invalidLines === 0 ? 'ready' : scan.aggregates.size === 0 ? 'query_error' : 'partial',
    cost: costRows ? cost : null,
    tin: tinRows ? tin : null,
    tout: toutRows ? tout : null,
    turns,
    invalidLines: scan.invalidLines,
    sourceBytes: scan.sourceBytes,
    ...(scan.invalidLines > 0 ? { error: `${scan.invalidLines} 行 usage 记录无法解析` } : {})
  }
}

export function deleteUsageSessionRows(args: {
  userDataDir: string
  providerId: SessionProviderId
  agentProfileId?: string
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
        agentProfileId?: string | null
        cwd?: string
        externalSessionId?: string | null
        runId?: string | null
      }
      const identityMatch =
        (row.providerId ?? 'legacy_unknown') === args.providerId &&
        (args.agentProfileId === undefined || row.agentProfileId === args.agentProfileId) &&
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
  agentProfileId?: string
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
        agentProfileId?: unknown
        cwd?: unknown
        externalSessionId?: unknown
        runId?: unknown
      }
      if (
        row.providerId === args.providerId &&
        (args.agentProfileId === undefined || row.agentProfileId === args.agentProfileId) && row.cwd === args.cwd &&
        row.externalSessionId === args.externalSessionId && typeof row.runId === 'string' && row.runId
      ) runIds.add(row.runId)
    } catch {
      // Corrupt rows are retained and cannot safely establish ownership.
    }
  }
  return [...runIds]
}
