import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type ToolContentRef } from '../../shared/tool-content.js'
import { type AgentTurnRecord } from '../../shared/turn-record.js'

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

export async function verifiedArchiveContent(path: string, expected: { bytes: number; sha256: string }): Promise<Buffer> {
  const content = await readFile(path)
  const digest = createHash('sha256').update(content).digest('hex')
  if (content.byteLength !== expected.bytes || digest !== expected.sha256) {
    throw new Error(`archive record does not match journal: ${path}`)
  }
  return content
}
