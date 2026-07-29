import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isAgentTurnRecord, type AgentTurnRecord } from '../../shared/turn-record.js'
import { appendRotatingLog, listFiles, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'

export const RECORDER_VERSION = '0.2.4'

export interface RecorderHealth {
  schemaVersion: 1
  lastSuccessAt?: string
  lastError?: { at: string; message: string }
  droppedEvents: number
  orphanEvents: number
  pendingCount: number
  oldestPendingAgeMs: number
  recoveredRecords: number
}

export interface ExportPage {
  records: AgentTurnRecord[]
  nextCursor: number
  hasMore: boolean
  snapshotMaxSequence: number
}

const RECORD_PATTERN = /^(\d{20})-([a-f0-9]{32,64})\.json$/

export function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]))
  }
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

export function safeKey(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session'
  return `${readable}-${stableHash(value).slice(0, 12)}`
}

function parseRecordName(name: string): { sequence: number; recordId: string } | null {
  const match = RECORD_PATTERN.exec(name)
  if (!match) return null
  const sequence = Number(match[1])
  return Number.isSafeInteger(sequence) && sequence > 0 ? { sequence, recordId: match[2] } : null
}

async function recordFiles(dataRoot: string): Promise<Array<{ name: string; sequence: number; recordId: string }>> {
  const out = (await listFiles(join(dataRoot, 'records'))).flatMap((name) => {
    const parsed = parseRecordName(name)
    return parsed ? [{ name, ...parsed }] : []
  })
  return out.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))
}

export async function readRecordFile(path: string): Promise<AgentTurnRecord> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isAgentTurnRecord(raw)) throw new Error(`invalid turn record: ${path}`)
  const parsed = parseRecordName(basename(path))
  if (!parsed || parsed.sequence !== raw.sequence || parsed.recordId !== raw.recordId) {
    throw new Error(`record filename/content mismatch: ${path}`)
  }
  return raw
}

export async function commitRecord(
  dataRoot: string,
  draft: Omit<AgentTurnRecord, 'sequence'>
): Promise<{ status: 'committed' | 'duplicate'; record: AgentTurnRecord }> {
  return withDirectoryLock(join(dataRoot, 'locks', 'commit.lock'), async () => {
    const files = await recordFiles(dataRoot)
    const duplicate = files.find((file) => file.recordId === draft.recordId)
    if (duplicate) {
      return { status: 'duplicate' as const, record: await readRecordFile(join(dataRoot, 'records', duplicate.name)) }
    }
    const sequence = (files.at(-1)?.sequence ?? 0) + 1
    const record: AgentTurnRecord = { ...draft, sequence }
    const filename = `${String(sequence).padStart(20, '0')}-${record.recordId}.json`
    await writeJsonAtomic(join(dataRoot, 'records', filename), record)
    // Cache only: commit recovery always trusts record files, never this value.
    await writeJsonAtomic(join(dataRoot, 'state', 'next-sequence.json'), { nextSequence: sequence + 1, rebuiltAt: new Date().toISOString() })
    return { status: 'committed' as const, record }
  })
}

export async function exportRecords(
  dataRoot: string,
  options: { after?: number; limit?: number; snapshotMaxSequence?: number } = {}
): Promise<ExportPage> {
  const after = Math.max(0, Math.floor(options.after ?? 0))
  const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 100)))
  const files = await recordFiles(dataRoot)
  const currentMax = files.at(-1)?.sequence ?? 0
  const snapshotMaxSequence = Math.min(options.snapshotMaxSequence ?? currentMax, currentMax)
  const selected = files.filter((file) => file.sequence > after && file.sequence <= snapshotMaxSequence).slice(0, limit)
  const records: AgentTurnRecord[] = []
  for (const file of selected) records.push(await readRecordFile(join(dataRoot, 'records', file.name)))
  const nextCursor = records.at(-1)?.sequence ?? after
  return {
    records,
    nextCursor,
    hasMore: files.some((file) => file.sequence > nextCursor && file.sequence <= snapshotMaxSequence),
    snapshotMaxSequence
  }
}

export async function listRecords(dataRoot: string): Promise<AgentTurnRecord[]> {
  const files = await recordFiles(dataRoot)
  const records: AgentTurnRecord[] = []
  for (const file of files) records.push(await readRecordFile(join(dataRoot, 'records', file.name)))
  return records
}

export async function showRecord(dataRoot: string, selector: string): Promise<AgentTurnRecord | null> {
  const records = await listRecords(dataRoot)
  const sequence = Number(selector)
  return records.find((record) => record.recordId === selector || (Number.isSafeInteger(sequence) && record.sequence === sequence)) ?? null
}

export async function verifyStore(dataRoot: string): Promise<{ ok: boolean; records: number; errors: string[] }> {
  const files = await recordFiles(dataRoot)
  const errors: string[] = []
  let previous = 0
  const ids = new Set<string>()
  for (const file of files) {
    if (file.sequence <= previous) errors.push(`non-monotonic sequence: ${file.name}`)
    if (file.sequence !== previous + 1) errors.push(`sequence gap before: ${file.name}`)
    previous = file.sequence
    if (ids.has(file.recordId)) errors.push(`duplicate recordId: ${file.recordId}`)
    ids.add(file.recordId)
    try {
      await readRecordFile(join(dataRoot, 'records', file.name))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { ok: errors.length === 0, records: files.length, errors }
}

const EMPTY_HEALTH: RecorderHealth = {
  schemaVersion: 1,
  droppedEvents: 0,
  orphanEvents: 0,
  pendingCount: 0,
  oldestPendingAgeMs: 0,
  recoveredRecords: 0
}

export async function readHealth(dataRoot: string): Promise<RecorderHealth> {
  return await readJson<RecorderHealth>(join(dataRoot, 'health.json')) ?? { ...EMPTY_HEALTH }
}

export async function updateHealth(
  dataRoot: string,
  update: Partial<Omit<RecorderHealth, 'schemaVersion'>> & {
    increment?: Partial<Pick<RecorderHealth, 'droppedEvents' | 'orphanEvents' | 'recoveredRecords'>>
  }
): Promise<RecorderHealth> {
  return withDirectoryLock(join(dataRoot, 'locks', 'health.lock'), async () => {
    const current = await readHealth(dataRoot)
    const next: RecorderHealth = {
      ...current,
      ...update,
      schemaVersion: 1,
      droppedEvents: current.droppedEvents + (update.increment?.droppedEvents ?? 0),
      orphanEvents: current.orphanEvents + (update.increment?.orphanEvents ?? 0),
      recoveredRecords: current.recoveredRecords + (update.increment?.recoveredRecords ?? 0)
    }
    delete (next as RecorderHealth & { increment?: unknown }).increment
    await writeJsonAtomic(join(dataRoot, 'health.json'), next)
    return next
  })
}

export async function recordError(dataRoot: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const at = new Date().toISOString()
  await updateHealth(dataRoot, { lastError: { at, message }, increment: { droppedEvents: 1 } }).catch(() => undefined)
  await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${at} ERROR ${message}`).catch(() => undefined)
}

export async function clearRuntimeTurn(dataRoot: string, path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
  await mkdir(join(dataRoot, 'runtime'), { recursive: true, mode: 0o700 })
}
