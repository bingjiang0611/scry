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
  /** 真正复制了字节；dry run 时 false，报告的是“会复制什么”。 */
  applied: boolean
  records: number
  refs: number
  present: number
  repairable: number
  missing: number
  repaired: number
  /** 本库已有这份 blob 但校验不过（同名不同字节）。工具不删也不覆盖它，只如实报告。 */
  corrupt: number
  /** 可修复正文的总字节数：dry run 为将要复制，`--apply` 为已复制。 */
  bytes: number
  /** 被查询过的来源内容根；未命中清单与它对读。 */
  sources: string[]
  missingItems: ContentRepairMissingItem[]
  missingItemsTruncated: boolean
  corruptItems: ContentRepairMissingItem[]
  corruptItemsTruncated: boolean
  /** 记录目录里不是记录、或读不出来的文件；只看不修，列出来是为了让“少几条记录”可解释。 */
  skipped: SkippedRecordFile[]
}

export interface ContentRepairOptions {
  dataRoot: string
  /** 其他内容根（App trace 库）；只按 sha256 与长度取字节，不信任路径之外的任何信息。 */
  sourceRoots: string[]
  /** 只修复指定记录；未找到的记录直接报错，不静默跳过。 */
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

/**
 * 修复正式记录引用但本库缺失的正文：先按 sha256 在给定来源库中找同一份字节（读时已校验长度与摘要），
 * 命中才复制进本库；未命中的只列清单。默认只读演练，`--apply` 才写盘。
 *
 * 这里不改写任何记录：要么把正文补回本库使既有引用重新可解析，要么报告它仍然缺。
 * 记录是否需要降级由提交边界（`resolveRecordContentRefs`）决定，不在修复工具里替用户决定证据语义。
 */
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
  // 同一份正文可能被多字段引用：按引用只处理一次，但未命中清单保留字段位置，便于定位记录。
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
        // 本库有这个名字的字节但校验不过：它不是缺失，来源库也补不上（同名地址只能有一份字节）。
        // 把它单独计为损坏，演练与 --apply 得到同一个分类。真正没有这份文件时才算缺失。
        if (isContentCorruptionError(error)) corruptHere = true
        else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (corruptHere) {
        // 删除或覆盖已存在的字节属于证据处理，修复工具不做，只如实报告，让用户自己决定。
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
        // 演练报告“将会复制多少字节”；只有真正写成功才在 --apply 里计入。
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
  // `applied` 指真正写入了字节，而不是“带 --apply 跑过一次”。
  report.applied = apply && report.repaired > 0
  return report
}

/** 返回第一个能兑现这条引用的来源字节；读时已由内容库校验长度与摘要。 */
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
