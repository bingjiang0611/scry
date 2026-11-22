import { isContentCorruptionError, readRecorderContent, writeRecorderContent } from './content-store.js'
import { findRecordById, listRecordsReport, recordContentItems, type SkippedRecordFile } from './store.js'
import type { ToolContentRef } from '../../shared/tool-content.js'
import type { AgentTurnRecord } from '../../shared/turn-record.js'

const MISSING_ITEM_LIMIT = 200

export interface ContentRepairMissingItem {
  recordId: string
  path: string
  sha256: string
  bytes: number
}

export interface ContentRepairReport {
  applied: boolean
  records: number
  refs: number
  present: number
  repairable: number
  missing: number
  repaired: number
  corrupt: number
  bytes: number
  sources: string[]
  missingItems: ContentRepairMissingItem[]
  missingItemsTruncated: boolean
  corruptItems: ContentRepairMissingItem[]
  corruptItemsTruncated: boolean
  skipped: SkippedRecordFile[]
}

export interface ContentRepairOptions {
  dataRoot: string
  sourceRoots: string[]
  recordIds?: string[]
  apply?: boolean
}

async function selectedRecords(
  dataRoot: string,
  recordIds: string[] | undefined
): Promise<{ records: AgentTurnRecord[]; skipped: SkippedRecordFile[] }> {
  if (!recordIds?.length) return listRecordsReport(dataRoot)
  const records: AgentTurnRecord[] = []
  for (const recordId of new Set(recordIds)) {
    const record = await findRecordById(dataRoot, recordId)
    if (!record) throw new Error(`record not found: ${recordId}`)
    records.push(record)
  }
  return { records, skipped: [] }
}

export async function repairRecordContent(options: ContentRepairOptions): Promise<ContentRepairReport> {
  const apply = options.apply === true
  const { records, skipped } = await selectedRecords(options.dataRoot, options.recordIds)
  const report: ContentRepairReport = {
    applied: false,
    records: records.length,
    refs: 0,
    present: 0,
    repairable: 0,
    missing: 0,
    repaired: 0,
    corrupt: 0,
    bytes: 0,
    sources: options.sourceRoots,
    missingItems: [],
    missingItemsTruncated: false,
    corruptItems: [],
    corruptItemsTruncated: false,
    skipped
  }
  const seen = new Map<string, ToolContentRef>()
  for (const record of records) {
    for (const item of recordContentItems(record)) {
      if (seen.has(item.ref.sha256)) continue
      seen.set(item.ref.sha256, item.ref)
      report.refs++
      const corruptItem = { recordId: record.recordId, path: item.path, sha256: item.ref.sha256, bytes: item.ref.bytes }
      let corruptHere = false
      try {
        await readRecorderContent(options.dataRoot, item.ref)
        report.present++
        continue
      } catch (error) {
        if (isContentCorruptionError(error)) corruptHere = true
        else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (corruptHere) {
        report.corrupt++
        if (report.corruptItems.length < MISSING_ITEM_LIMIT) report.corruptItems.push(corruptItem)
        else report.corruptItemsTruncated = true
        continue
      }
      const content = await readFromSources(options.sourceRoots, item.ref)
      if (content === undefined) {
        report.missing++
        if (report.missingItems.length < MISSING_ITEM_LIMIT) report.missingItems.push(corruptItem)
        else report.missingItemsTruncated = true
        continue
      }
      report.repairable++
      if (!apply) {
        report.bytes += item.ref.bytes
        continue
      }
      const written = await writeRecorderContent(options.dataRoot, content, item.ref.encoding)
      if (written.sha256 !== item.ref.sha256 || written.bytes !== item.ref.bytes) {
        throw new Error(`recorder content repair wrote unexpected bytes for ${item.ref.sha256}`)
      }
      report.repaired++
      report.bytes += item.ref.bytes
    }
  }
  report.applied = apply && report.repaired > 0
  return report
}

async function readFromSources(sourceRoots: string[], ref: ToolContentRef): Promise<string | undefined> {
  for (const root of sourceRoots) {
    try {
      return await readRecorderContent(root, ref)
    } catch {
      continue
    }
  }
  return undefined
}
