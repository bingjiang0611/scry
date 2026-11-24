import { join } from 'node:path'
import { PROVIDER_LABELS, type ProviderId } from '../../shared/provider.js'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import { readJson, withDirectoryLock, writeJsonAtomic } from './io.js'
import { readRecordFile, recordFiles } from './store-index.js'

export interface RecordSummary {
  name: string
  sequence: number
  recordId: string
  provider: ProviderId
  sessionId: string
  generation: number
  turnIndex: number
  providerTurnId: string | null
}

const SUMMARY_SCHEMA = 1
const SUMMARY_FILE = 'records-summary.json'
const SUMMARY_LOCK = 'records-summary.lock'
// Derived, never hand-listed: `PROVIDER_LABELS` is a `Record<ProviderId, string>`, so adding a host
// to the shared union fails that map to compile until it is added here too. A subset would reject
// the new host's rows and silently drop the cache to a full parse on every read.
const PROVIDERS = new Set<string>(Object.keys(PROVIDER_LABELS))

/**
 * One row per record, in file order. The file name carries both sequence and record id, so it is
 * the row's identity and the thing a stale cache is checked against.
 */
type SummaryRow = [name: string, provider: string, sessionId: string, generation: number, turnIndex: number, providerTurnId: string | null]

export function recordSummaryPath(dataRoot: string): string {
  return join(dataRoot, SUMMARY_FILE)
}

function recordNameOf(record: AgentTurnRecord): string {
  return `${String(record.sequence).padStart(20, '0')}-${record.recordId}.json`
}

function rowOf(record: AgentTurnRecord): SummaryRow {
  return [
    recordNameOf(record),
    record.provider.id,
    record.sessionId,
    record.generation,
    record.turnIndex,
    record.providerTurnId ?? null
  ]
}

function summaryOf(row: SummaryRow, sequence: number, recordId: string): RecordSummary {
  return {
    name: row[0],
    sequence,
    recordId,
    provider: row[1] as ProviderId,
    sessionId: row[2],
    generation: row[3],
    turnIndex: row[4],
    providerTurnId: row[5]
  }
}

function rowOfRaw(raw: unknown): SummaryRow | null {
  if (!Array.isArray(raw) || raw.length !== 6) return null
  const [name, provider, sessionId, generation, turnIndex, providerTurnId] = raw as unknown[]
  if (typeof name !== 'string' || typeof provider !== 'string' || !PROVIDERS.has(provider)) return null
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return null
  if (typeof turnIndex !== 'number' || !Number.isSafeInteger(turnIndex) || turnIndex < 0) return null
  if (providerTurnId !== null && typeof providerTurnId !== 'string') return null
  return [name, provider, sessionId, generation, turnIndex, providerTurnId]
}

async function readSummaryRows(dataRoot: string): Promise<SummaryRow[] | null> {
  const raw = await readJson<{ schemaVersion?: unknown; entries?: unknown }>(recordSummaryPath(dataRoot))
  if (!raw || raw.schemaVersion !== SUMMARY_SCHEMA || !Array.isArray(raw.entries)) return null
  const rows: SummaryRow[] = []
  for (const entry of raw.entries) {
    const row = rowOfRaw(entry)
    if (!row) return null
    rows.push(row)
  }
  return rows
}

async function writeSummaryRows(dataRoot: string, rows: SummaryRow[]): Promise<void> {
  await withDirectoryLock(join(dataRoot, 'locks', SUMMARY_LOCK), async () => {
    await writeJsonAtomic(recordSummaryPath(dataRoot), { schemaVersion: SUMMARY_SCHEMA, entries: rows })
  })
}

function rowsMatchFiles(rows: SummaryRow[], names: string[]): boolean {
  return rows.length === names.length && rows.every((row, index) => row[0] === names[index])
}

/**
 * The same information `listRecords()` would give, without parsing the records unless the cache is
 * unusable. Name-valid records whose content cannot be read still throw, exactly as they do there:
 * silently dropping them would report broken evidence as an absent turn.
 */
export async function listRecordSummaries(dataRoot: string): Promise<RecordSummary[]> {
  const files = await recordFiles(dataRoot)
  const rows = await readSummaryRows(dataRoot)
  if (rows && rowsMatchFiles(rows, files.map((file) => file.name))) {
    return rows.map((row, index) => summaryOf(row, files[index]!.sequence, files[index]!.recordId))
  }
  const summaries: RecordSummary[] = []
  for (const file of files) {
    summaries.push(summaryOf(rowOf(await readRecordFile(join(dataRoot, 'records', file.name))), file.sequence, file.recordId))
  }
  // Rebuilding is best effort: a caller still gets the answer even when the cache cannot be written.
  await writeSummaryRows(dataRoot, summaries.map((summary) => [summary.name, summary.provider, summary.sessionId, summary.generation, summary.turnIndex, summary.providerTurnId])).catch(() => undefined)
  return summaries
}

/**
 * Record one committed record in the cache. Called from inside the commit lock, so it must stay
 * cheap and must never fail the commit: with no usable cache it does nothing at all, because
 * rebuilding here would put the whole store's parse inside the commit. A reader builds it instead.
 */
export async function appendRecordSummary(dataRoot: string, record: AgentTurnRecord): Promise<void> {
  const name = recordNameOf(record)
  await withDirectoryLock(join(dataRoot, 'locks', SUMMARY_LOCK), async () => {
    const files = await recordFiles(dataRoot)
    const rows = await readSummaryRows(dataRoot)
    if (!rows || rows.length !== files.length - 1) return
    if (!rowsMatchFiles(rows, files.slice(0, -1).map((file) => file.name))) return
    if (files.at(-1)?.name !== name) return
    await writeJsonAtomic(recordSummaryPath(dataRoot), { schemaVersion: SUMMARY_SCHEMA, entries: [...rows, rowOf(record)] })
  })
}
