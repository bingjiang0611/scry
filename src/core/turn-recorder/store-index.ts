import { createHash } from 'node:crypto'
import { stat, readFile, lstat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { type ToolContentRef } from '../../shared/tool-content.js'
import { type AgentTurnRecord, validateAgentTurnRecord } from '../../shared/turn-record.js'
import { listFiles } from './io.js'


const RECORD_PATTERN = /^(\d{20})-([a-f0-9]{32,64})\.json$/

type RecordFileEntry = { name: string; sequence: number; recordId: string }

interface RecordDirectoryStamp {
  dev: string
  ino: string
  mtimeNs: string
  ctimeNs: string
}

/** Disposable process-local projection. Canonical records remain the only persisted authority. */
interface RecordStoreIndex {
  stamp: RecordDirectoryStamp
  entries: RecordFileEntry[]
}

const RECORD_INDEX_CACHE_LIMIT = 32
const recordIndexCache = new Map<string, RecordStoreIndex>()
let recordIndexHits = 0
let recordIndexMisses = 0

export function recordStoreIndexStats(): { hits: number; misses: number; entries: number } {
  return { hits: recordIndexHits, misses: recordIndexMisses, entries: recordIndexCache.size }
}

export function resetRecordStoreIndex(): void {
  recordIndexCache.clear()
  recordIndexHits = 0
  recordIndexMisses = 0
}

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

export function parseRecordName(name: string): { sequence: number; recordId: string } | null {
  const match = RECORD_PATTERN.exec(name)
  if (!match) return null
  const sequence = Number(match[1])
  return Number.isSafeInteger(sequence) && sequence > 0 ? { sequence, recordId: match[2] } : null
}

async function recordDirectoryStamp(path: string): Promise<RecordDirectoryStamp | null> {
  try {
    const info = await stat(path, { bigint: true })
    return {
      dev: String(info.dev),
      ino: String(info.ino),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameRecordStamp(left: RecordDirectoryStamp | null, right: RecordDirectoryStamp | null): boolean {
  return left === right || (!!left && !!right && left.dev === right.dev && left.ino === right.ino && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs)
}

async function scanRecordFiles(dataRoot: string): Promise<{ entries: RecordFileEntry[]; stamp: RecordDirectoryStamp | null }> {
  const recordsPath = join(dataRoot, 'records')
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await recordDirectoryStamp(recordsPath)
    const entries = (await listFiles(recordsPath)).flatMap((name) => {
      const parsed = parseRecordName(name)
      return parsed ? [{ name, ...parsed }] : []
    }).sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))
    const after = await recordDirectoryStamp(recordsPath)
    if (sameRecordStamp(before, after)) return { entries, stamp: after }
  }
  throw new Error('record store changed while building derived index')
}

export async function recordFiles(dataRoot: string, options: { bypassIndex?: boolean } = {}): Promise<RecordFileEntry[]> {
  if (!options.bypassIndex) {
    const stamp = await recordDirectoryStamp(join(dataRoot, 'records'))
    const cached = recordIndexCache.get(dataRoot)
    if (cached && sameRecordStamp(cached.stamp, stamp)) {
      recordIndexCache.delete(dataRoot)
      recordIndexCache.set(dataRoot, cached)
      recordIndexHits++
      return cached.entries.map((entry) => ({ ...entry }))
    }
    recordIndexMisses++
  }

  const scanned = await scanRecordFiles(dataRoot)
  if (scanned.stamp && !options.bypassIndex) {
    recordIndexCache.set(dataRoot, { stamp: scanned.stamp, entries: scanned.entries })
    while (recordIndexCache.size > RECORD_INDEX_CACHE_LIMIT) {
      const oldest = recordIndexCache.keys().next().value
      if (typeof oldest !== 'string') break
      recordIndexCache.delete(oldest)
    }
  }
  return scanned.entries
}

export function invalidateRecordIndex(dataRoot: string): void {
  recordIndexCache.delete(dataRoot)
}

/**
 * 按 recordId 精确定位一条正式记录。recordId 就写在文件名里，`readRecordFile`
 * 又强校验文件名↔内容一致，所以这里只读那一个文件，不解析整个 store。
 * 语义与「全量扫描后按 recordId 过滤」等价。
 */
export async function findRecordById(dataRoot: string, recordId: string): Promise<AgentTurnRecord | undefined> {
  const match = (await recordFiles(dataRoot)).find((file) => file.recordId === recordId)
  return match ? await readRecordFile(join(dataRoot, 'records', match.name)) : undefined
}

/**
 * 只由文件名派生的存储指纹（不读正文）。records 是 append-only 且序号严格递增，
 * 因此任何新提交都会改变 count 或 maxSequence —— 派生缓存用它判断自己是否仍然新鲜。
 * 它不是事实源，也不能替代记录本身的校验。
 */
export async function recordStoreStamp(dataRoot: string): Promise<{ count: number; maxSequence: number }> {
  const files = await recordFiles(dataRoot)
  return { count: files.length, maxSequence: files.at(-1)?.sequence ?? 0 }
}

// Recorder 0.2.16–0.2.18 could serialize empty model events without a text field.
// Drop only that known placeholder in the read view and mark the evidence partial;
// canonical bytes and the strict commit validator stay untouched.
function legacyModelSegmentsReadView(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const version = typeof record.recorderVersion === 'string' ? /^0\.2\.(\d+)$/.exec(record.recorderVersion) : null
  if (record.schemaVersion !== 1 || !version || Number(version[1]) < 16 || Number(version[1]) > 18) return raw
  const modelSegments = record.modelSegments
  if (!modelSegments || typeof modelSegments !== 'object' || Array.isArray(modelSegments)) return raw
  const evidence = modelSegments as Record<string, unknown>
  if (!Array.isArray(evidence.value)) return raw
  const keys = new Set(['order', 'at', 'kind', 'text', 'messageId', 'providerItemId', 'parentId', 'agentId'])
  const isLegacyEmptySegment = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const segment = value as Record<string, unknown>
    return Object.keys(segment).every((key) => keys.has(key)) &&
      Number.isSafeInteger(segment.order) && Number(segment.order) >= 0 &&
      typeof segment.at === 'string' && Number.isFinite(Date.parse(segment.at)) &&
      (segment.kind === 'text' || segment.kind === 'thinking') &&
      (segment.text === undefined || segment.text === '') &&
      ['messageId', 'providerItemId', 'parentId', 'agentId'].every(
        (key) => segment[key] === undefined || typeof segment[key] === 'string'
      )
  }
  const omitted = evidence.value.filter(isLegacyEmptySegment)
  if (omitted.length === 0) return raw
  const value = evidence.value.filter((segment) => !isLegacyEmptySegment(segment))
  return {
    ...record,
    modelSegments: {
      ...evidence,
      status: 'partial',
      value,
      omissionReason: 'legacy recorder omitted empty model segment text'
    }
  }
}

// Older aggregators wrapped an unavailable residual timing result as partial.
// Normalize only that known writer defect in the read view; canonical bytes and
// the strict commit validator stay untouched, and no timing value is invented.
function legacyModelTimingReadView(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const version = typeof record.recorderVersion === 'string' ? /^0\.2\.(\d+)$/.exec(record.recorderVersion) : null
  if (record.schemaVersion !== 1 || !version || Number(version[1]) < 27 || Number(version[1]) > 34) return raw
  const timing = record.modelTiming
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return raw
  const evidence = timing as Record<string, unknown>
  if (evidence.status !== 'partial' || evidence.quality !== 'unavailable' ||
      evidence.omissionReason !== 'turn wall-clock is inconsistent with observed activity intervals') return raw
  const value = evidence.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return raw
  const residual = value as Record<string, unknown>
  if (residual.method !== 'non_call_residual' || !residual.activityCoverage ||
      Object.keys(residual).some((key) => key !== 'method' && key !== 'activityCoverage')) return raw
  return { ...record, modelTiming: { ...evidence, status: 'unavailable' } }
}

export async function readRecordFile(path: string): Promise<AgentTurnRecord> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  const validation = validateAgentTurnRecord(legacyModelTimingReadView(legacyModelSegmentsReadView(raw)))
  if (!validation.ok) {
    const detail = validation.issues.slice(0, 4).map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new Error(`invalid turn record: ${path}: ${detail}`)
  }
  const record = validation.record
  const parsed = parseRecordName(basename(path))
  if (!parsed || parsed.sequence !== record.sequence || parsed.recordId !== record.recordId) {
    throw new Error(`record filename/content mismatch: ${path}`)
  }
  return record
}

export async function existingFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function existingPath(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export interface RecordContentItem {
  path: string
  ref: ToolContentRef
}

export function recordContentItems(record: AgentTurnRecord): RecordContentItem[] {
  const items: RecordContentItem[] = []
  for (const section of ['tools', 'skills', 'mcps'] as const) {
    for (const [index, call] of (record[section].value ?? []).entries()) {
      if (call.inputContent?.contentRef) items.push({ path: `${section}.${index}.input`, ref: call.inputContent.contentRef })
      if (call.outputContent?.contentRef) items.push({ path: `${section}.${index}.output`, ref: call.outputContent.contentRef })
    }
  }
  for (const [segmentIndex, segment] of (record.modelSegments?.value ?? []).entries()) {
    for (const [refIndex, ref] of (segment.contentRefs ?? []).entries()) {
      items.push({ path: `modelSegments.${segmentIndex}.${refIndex}`, ref })
    }
  }
  for (const [refIndex, ref] of (record.assistant.value?.contentRefs ?? []).entries()) {
    items.push({ path: `assistant.${refIndex}`, ref })
  }
  for (const [snapshotIndex, snapshot] of (record.diff.value ?? []).entries()) {
    for (const [fileIndex, file] of snapshot.files.entries()) {
      if (file.patchContent?.contentRef) items.push({ path: `diff.${snapshotIndex}.${fileIndex}.patch`, ref: file.patchContent.contentRef })
    }
  }
  if (record.transcript?.value?.contentRef) items.push({ path: 'transcript', ref: record.transcript.value.contentRef })
  return items
}

export function recordContentItem(record: AgentTurnRecord, path: string): RecordContentItem | undefined {
  return recordContentItems(record).find((item) => item.path === path)
}

export function addContentRefs(refs: Map<string, ToolContentRef>, record: AgentTurnRecord): void {
  for (const { ref } of recordContentItems(record)) {
    const existing = refs.get(ref.sha256)
    if (existing && existing.bytes !== ref.bytes) throw new Error(`conflicting recorder content reference: ${ref.sha256}`)
    refs.set(ref.sha256, existing ?? ref)
  }
}

export function collectContentRefs(records: AgentTurnRecord[]): ToolContentRef[] {
  const refs = new Map<string, ToolContentRef>()
  for (const record of records) addContentRefs(refs, record)
  return [...refs.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
}
