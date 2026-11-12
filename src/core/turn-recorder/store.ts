import { persistUploadEnvironment } from './commit-environment.js'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type ToolContentRef } from '../../shared/tool-content.js'
import { type AgentTurnRecord, validateAgentTurnRecord } from '../../shared/turn-record.js'
import { copyRecorderContent } from './content-store.js'
import { withDirectoryLock, writeJsonAtomic, mkdirDurable, syncDirectory, readJson, appendRotatingLog } from './io.js'
import { recordFiles, readRecordFile, invalidateRecordIndex, addContentRefs, parseRecordName } from './store-index.js'
import { applyRecordContentBudget, recordTransportBytes, RECORDER_TRANSPORT_MAX_BYTES } from './record-content-budget.js'
import { archiveJournal, readArchiveState, archivePathsOverlap } from './store-archive.js'
import { nextSequence, reserveSequence } from './sequence-watermark.js'
import { pruneStaleTemps } from './temp-prune.js'
export { recordStoreIndexStats, resetRecordStoreIndex, stableHash, safeKey, findRecordById, recordStoreStamp, readRecordFile, type RecordContentItem, recordContentItems, recordContentItem } from './store-index.js'
export { type RecordCommittedNotification, type CommitNotificationStatus, type CommitNotificationScope, commitNotificationStatus, HOOK_DRAIN_MAX_RECORDS, HOOK_DRAIN_BUDGET_MS, type DrainOptions, type DrainResult, drainCommitNotifications, retryCommitNotifications, redeliverLatestCommitNotification } from './store-notifications.js'
export { type ArchiveState, readArchiveState, type ArchiveOptions, archiveRecords } from './store-archive.js'


export const RECORDER_VERSION = '0.2.67'

export interface RecorderHealth {
  schemaVersion: 1
  lastSuccessAt?: string
  lastError?: { at: string; message: string }
  droppedEvents: number
  orphanEvents: number
  missingStartTerminals: number
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

export async function commitRecord(
  dataRoot: string,
  draft: Omit<AgentTurnRecord, 'sequence'>,
  uploadEnvironment?: import('./commit-environment.js').UploadEnvironment
): Promise<{ status: 'committed' | 'duplicate'; record: AgentTurnRecord }> {
  if (!/^[a-f0-9]{32,64}$/.test(draft.recordId)) throw new Error('recordId must be a 32-64 character lowercase hex digest')
  return withDirectoryLock(join(dataRoot, 'locks', 'commit.lock'), async () => {
    if (await archiveJournal(dataRoot)) {
      throw new Error('pending archive must be resumed before committing another record')
    }
    // Allocation and duplicate detection never trust a derived projection.
    const files = await recordFiles(dataRoot, { bypassIndex: true })
    const duplicate = files.find((file) => file.recordId === draft.recordId)
    if (duplicate) {
      return { status: 'duplicate' as const, record: await readRecordFile(join(dataRoot, 'records', duplicate.name)) }
    }
    // The allocator must clear every floor that proves a sequence was already issued: the durable
    // watermark (record files deleted by hand), the archive floor (records moved out on purpose) and
    // the live maximum (records restored from an older backup). Duplicate detection only scans live
    // records: archiving is therefore restricted to finalized turns (and, when a commit hook exists,
    // acknowledged ones), which cannot be re-committed.
    const archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
    const sequence = await nextSequence(dataRoot, { liveMax: files.at(-1)?.sequence ?? 0, archivedThrough })
    // Both the App-managed path and the standalone CLI publish here, so one convergence point keeps
    // every committed record inside the transport envelope the receiver validates.
    const record: AgentTurnRecord = { ...applyRecordContentBudget(draft), sequence }
    // 收缩之后仍然超出信封就拒绝提交：接收方会拒收，写进 store 只会制造一条永远传不出去的记录。
    const transportBytes = recordTransportBytes(record)
    if (transportBytes > RECORDER_TRANSPORT_MAX_BYTES) {
      throw new Error(`refusing to commit record above the transport envelope: ${transportBytes} > ${RECORDER_TRANSPORT_MAX_BYTES} bytes`)
    }
    const validation = validateAgentTurnRecord(record)
    if (!validation.ok) {
      const detail = validation.issues.slice(0, 4).map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      throw new Error(`refusing to commit invalid turn record: ${detail}`)
    }
    // Reserve the number durably before the record exists: a crash may skip a sequence, never reuse one.
    await reserveSequence(dataRoot, sequence)
    const filename = `${String(sequence).padStart(20, '0')}-${record.recordId}.json`
    // Publish the private snapshot first: a visible record must never race ahead of its env.
    if (uploadEnvironment !== undefined) await persistUploadEnvironment(dataRoot, record.recordId, uploadEnvironment)
    await writeJsonAtomic(join(dataRoot, 'records', filename), record)
    invalidateRecordIndex(dataRoot)
    // 中断的写入会留下永不 rename 上屏的 `.tmp`（0 字节也算）：它们不是记录，但会被按目录枚举的
    // 脚本读到。提交是所有写入方唯一的收敛点，所以在这里按天清理一次；失败只影响这次卫生。
    await pruneStaleTemps(dataRoot).catch(() => undefined)
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

export interface RecordExportBundle {
  target: string
  records: number
  contents: number
  snapshotMaxSequence: number
}

export async function exportRecordBundle(dataRoot: string, target: string): Promise<RecordExportBundle> {
  const canonicalRoot = resolve(dataRoot)
  const canonicalTarget = resolve(target)
  if (archivePathsOverlap(canonicalRoot, canonicalTarget)) {
    throw new Error('export target must not overlap the recorder store')
  }
  const files = await recordFiles(dataRoot)
  const snapshotMaxSequence = files.at(-1)?.sequence ?? 0
  const parent = resolve(canonicalTarget, '..')
  await mkdir(parent, { recursive: true })
  const temp = await mkdtemp(join(parent, '.scry-export-'))
  try {
    const recordsDir = join(temp, 'records')
    await mkdirDurable(recordsDir)
    const refs = new Map<string, ToolContentRef>()
    for (const file of files) {
      const record = await readRecordFile(join(dataRoot, 'records', file.name))
      await writeJsonAtomic(join(recordsDir, file.name), record)
      addContentRefs(refs, record)
    }
    for (const ref of refs.values()) await copyRecorderContent(dataRoot, temp, ref)
    await writeJsonAtomic(join(temp, 'manifest.json'), {
      schemaVersion: 1,
      kind: 'scry-recorder-export',
      createdAt: new Date().toISOString(),
      snapshotMaxSequence,
      records: files.map((file) => ({ name: file.name, sequence: file.sequence, recordId: file.recordId })),
      contents: [...refs.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
    })
    await syncDirectory(temp)
    await rename(temp, canonicalTarget)
    await syncDirectory(parent)
    return { target: canonicalTarget, records: files.length, contents: refs.size, snapshotMaxSequence }
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}

/**
 * 严格读出每条正式记录。名字合规但内容读不出来的文件必须让读取失败：静默跳过等于把损坏的证据
 * 显示成“没有这条记录”。需要跑完并如实报告跳过了什么的路径用 `listRecordsReport`。
 */
export async function listRecords(dataRoot: string): Promise<AgentTurnRecord[]> {
  const files = await recordFiles(dataRoot)
  const records: AgentTurnRecord[] = []
  for (const file of files) records.push(await readRecordFile(join(dataRoot, 'records', file.name)))
  return records
}

/**
 * 记录目录的文件名列表。`listFiles` 会把任何错误都当成空目录，而“没有记录”和“目录读不了”是两件
 * 完全不同的事：报告路径必须让后者失败。
 */
async function recordFileNames(dataRoot: string): Promise<string[]> {
  try {
    return (await readdir(join(dataRoot, 'records'), { encoding: 'utf8' })).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** 只按文件名判断：这些文件根本不是记录（`.tmp`、手工产物），不需要读内容就能报出来。 */
export async function skippedRecordFiles(dataRoot: string): Promise<SkippedRecordFile[]> {
  return (await recordFileNames(dataRoot))
    .filter((name) => !parseRecordName(name))
    .map((name) => ({ name, reason: 'unrecognized_name' as const }))
}

export interface SkippedRecordFile {
  name: string
  /** `unrecognized_name`：不符合 `<20 位序号>-<recordId>.json`，例如中断留下的 `.tmp`。
   *  `unreadable_record`：名字合规但读不出来（截断、损坏、不是合法记录）。 */
  reason: 'unrecognized_name' | 'unreadable_record'
}

/**
 * 枚举正式记录，并告诉调用方跳过了多少文件、为什么。记录目录不是只有记录：原子写盘会在同一目录里
 * 留下 `.tmp`，崩溃也可能留下半成品。报告型路径（修复、维护、诊断）必须能跑完并如实列出这些文件，
 * 而不是在第一条上崩掉。导出路径仍直接读 `recordFiles` 并让校验错误抛出，避免静默少传记录。
 */
export async function listRecordsReport(dataRoot: string): Promise<{ records: AgentTurnRecord[]; skipped: SkippedRecordFile[] }> {
  const records: AgentTurnRecord[] = []
  const skipped: SkippedRecordFile[] = []
  const names = await recordFileNames(dataRoot)
  for (const name of names) {
    if (!parseRecordName(name)) {
      skipped.push({ name, reason: 'unrecognized_name' })
      continue
    }
    try {
      records.push(await readRecordFile(join(dataRoot, 'records', name)))
    } catch {
      skipped.push({ name, reason: 'unreadable_record' })
    }
  }
  records.sort((left, right) => left.sequence - right.sequence)
  return { records, skipped }
}

export async function showRecord(dataRoot: string, selector: string): Promise<AgentTurnRecord | null> {
  const files = await recordFiles(dataRoot)
  const sequence = /^\d+$/.test(selector) ? Number(selector) : undefined
  const match = files.find((file) => file.recordId === selector || file.sequence === sequence)
  return match ? await readRecordFile(join(dataRoot, 'records', match.name)) : null
}

/**
 * Which CLI actually wrote the newest record. A workspace can easily end up with more than one
 * install — a hook pinned through `SCRY_CLI_PATH` and whatever `scry` resolves to in a shell —
 * and then upgrading one of them silently leaves recording on the other. Reads one file.
 */
export async function lastRecordVersion(dataRoot: string): Promise<string | null> {
  const files = await recordFiles(dataRoot)
  const newest = files.at(-1)
  if (!newest) return null
  try {
    return (await readRecordFile(join(dataRoot, 'records', newest.name))).recorderVersion
  } catch {
    return null
  }
}

/**
 * Which installs are still writing. One newest record hides a split install: when a second
 * recorder keeps committing after an upgrade, the newest file shows the new version while the
 * old one still owns part of the batch. Samples the newest `limit` records and counts versions.
 */
export async function recentRecordVersions(
  dataRoot: string,
  limit = 20
): Promise<Array<{ version: string; records: number }>> {
  const counts = new Map<string, number>()
  for (const file of (await recordFiles(dataRoot)).slice(-limit)) {
    try {
      const record = await readRecordFile(join(dataRoot, 'records', file.name))
      counts.set(record.recorderVersion, (counts.get(record.recorderVersion) ?? 0) + 1)
    } catch {
      // Unreadable records are `store.integrity` evidence; they cannot prove a writer version.
    }
  }
  return [...counts]
    .map(([version, records]) => ({ version, records }))
    .sort((a, b) => b.records - a.records || a.version.localeCompare(b.version))
}

export async function verifyStore(
  dataRoot: string,
  onRecord?: (record: AgentTurnRecord) => void
): Promise<{ ok: boolean; records: number; errors: string[]; archivedThrough: number; maxSequence: number }> {
  // Integrity verification always bypasses disposable projections and scans canonical filenames.
  const files = await recordFiles(dataRoot, { bypassIndex: true })
  const errors: string[] = []
  // An archived prefix is only acceptable when an archive operation recorded the floor.
  let archivedThrough = 0
  try {
    archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const journal = await archiveJournal(dataRoot)
    if (journal) errors.push(`pending archive journal: ${journal.transactionId}`)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  let previous = archivedThrough
  const ids = new Set<string>()
  for (const file of files) {
    if (file.sequence <= previous) errors.push(`non-monotonic sequence: ${file.name}`)
    if (file.sequence !== previous + 1) errors.push(`sequence gap before: ${file.name}`)
    previous = file.sequence
    if (ids.has(file.recordId)) errors.push(`duplicate recordId: ${file.recordId}`)
    ids.add(file.recordId)
    let record: AgentTurnRecord
    try {
      record = await readRecordFile(join(dataRoot, 'records', file.name))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    // Synchronous consumers can reuse validated records without retaining their bodies.
    // Consumer errors must propagate, not be misreported as corrupt canonical records.
    onRecord?.(record)
  }
  return { ok: errors.length === 0, records: files.length, errors, archivedThrough, maxSequence: files.at(-1)?.sequence ?? 0 }
}

const EMPTY_HEALTH: RecorderHealth = {
  schemaVersion: 1,
  droppedEvents: 0,
  orphanEvents: 0,
  missingStartTerminals: 0,
  pendingCount: 0,
  oldestPendingAgeMs: 0,
  recoveredRecords: 0
}

export async function readHealth(dataRoot: string): Promise<RecorderHealth> {
  return { ...EMPTY_HEALTH, ...await readJson<RecorderHealth>(join(dataRoot, 'health.json')) }
}

export async function updateHealth(
  dataRoot: string,
  update: Partial<Omit<RecorderHealth, 'schemaVersion'>> & {
    increment?: Partial<Pick<RecorderHealth, 'droppedEvents' | 'orphanEvents' | 'missingStartTerminals' | 'recoveredRecords'>>
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
      missingStartTerminals: current.missingStartTerminals + (update.increment?.missingStartTerminals ?? 0),
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
