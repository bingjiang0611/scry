import { type ToolContent, type ToolContentRef } from '../../shared/tool-content.js'
import type { AgentTurnRecord, Evidence, TurnCall, TurnDiffSnapshotRecord, TurnModelSegment, TurnTranscriptSource } from '../../shared/turn-record.js'
import { degradedSection } from './managed-capture.js'
import { recordContentItems, RECORD_CONTENT_PRIORITY, type RecordContentPriority } from './store-index.js'
import { limitToolContent } from './tool-content.js'


export const RECORDER_CONTENT_MAX_BYTES = 8 * 1024 * 1024
export const RECORDER_CONTENT_MAX_REFS = 512
export const RECORDER_TRANSPORT_MAX_BYTES = 16 * 1024 * 1024
export const RECORDER_INLINE_PREVIEW_BYTES = 8 * 1024
export const RECORDER_TRANSPORT_ENCODING = 'recorder-content-v1'
export const CONTENT_ENVELOPE_REASON = 'record transport budget dropped complete bodies'

type RecordDraft = Omit<AgentTurnRecord, 'sequence'>

function base64Bytes(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}

function entryBytes(ref: ToolContentRef): number {
  const literal = JSON.stringify({ sha256: ref.sha256, bytes: ref.bytes, dataBase64: '' })
  return Buffer.byteLength(JSON.stringify(literal)) - 2 + 1
}

function envelopeBytes(recordJson: string, refs: readonly ToolContentRef[]): number {
  const contentJson = JSON.stringify(refs.map(({ sha256, bytes }) => ({ sha256, bytes, dataBase64: '' })))
  return Buffer.byteLength(JSON.stringify({ scryEncoding: RECORDER_TRANSPORT_ENCODING, recordJson, contentJson })) +
    refs.reduce((sum, ref) => sum + base64Bytes(ref.bytes), 0)
}

export function recordContentRefs(record: RecordDraft): ToolContentRef[] {
  const refs = new Map<string, ToolContentRef>()
  for (const { ref } of recordContentItems(record)) {
    const previous = refs.get(ref.sha256)
    if (previous && previous.bytes !== ref.bytes) throw new Error(`conflicting recorder content reference: ${ref.sha256}`)
    if (!previous) refs.set(ref.sha256, ref)
  }
  return [...refs.values()]
}

function refPriorities(record: RecordDraft): Map<string, RecordContentPriority> {
  const priorities = new Map<string, RecordContentPriority>()
  const rank = (priority: RecordContentPriority) => RECORD_CONTENT_PRIORITY.indexOf(priority)
  for (const { ref, priority } of recordContentItems(record)) {
    const previous = priorities.get(ref.sha256)
    if (!previous || rank(priority) < rank(previous)) priorities.set(ref.sha256, priority)
  }
  return priorities
}

export function recordTransportBytes(record: RecordDraft): number {
  return envelopeBytes(JSON.stringify(record), recordContentRefs(record))
}

function degradeField(field: ToolContent, dropped: Set<string>): { field: ToolContent; lost: boolean } {
  if (!field.contentRef || !dropped.has(field.contentRef.sha256)) return { field, lost: false }
  const { contentRef: _contentRef, ...rest } = field
  if (rest.storage === 'complete' && rest.content !== undefined) return { field: rest, lost: false }
  return {
    lost: true,
    field: {
      ...rest,
      storage: rest.content === undefined ? 'omitted' : 'truncated',
      reasons: [...new Set([...rest.reasons, 'turn_budget' as const])]
    }
  }
}

function withoutRefs<T extends { contentRefs?: ToolContentRef[] }>(value: T, dropped: Set<string>): { value: T; lost: boolean } {
  if (!value.contentRefs?.length) return { value, lost: false }
  const contentRefs = value.contentRefs.filter((ref) => !dropped.has(ref.sha256))
  if (contentRefs.length === value.contentRefs.length) return { value, lost: false }
  const { contentRefs: _contentRefs, ...rest } = value
  return { value: contentRefs.length ? { ...value, contentRefs } : rest as T, lost: true }
}

function callsSection(section: Evidence<TurnCall[]>, dropped: Set<string>): Evidence<TurnCall[]> {
  if (!section.value) return section
  let lost = false
  const value = section.value.map((call): TurnCall => {
    const input = call.inputContent ? degradeField(call.inputContent, dropped) : undefined
    const output = call.outputContent ? degradeField(call.outputContent, dropped) : undefined
    lost ||= Boolean(input?.lost || output?.lost)
    if (!input?.lost && !output?.lost) return call
    return {
      ...call,
      ...(input ? { inputContent: input.field } : {}),
      ...(output ? { outputContent: output.field } : {})
    }
  })
  return lost ? degradedSection({ ...section, value }, CONTENT_ENVELOPE_REASON) : { ...section, value }
}

function segmentsSection(
  section: Evidence<TurnModelSegment[]> | undefined,
  dropped: Set<string>
): Evidence<TurnModelSegment[]> | undefined {
  if (!section?.value) return section
  let lost = false
  const value = section.value.map((segment) => {
    const refs = withoutRefs(segment, dropped)
    lost ||= refs.lost
    return refs.value
  })
  return lost ? degradedSection({ ...section, value }, CONTENT_ENVELOPE_REASON) : { ...section, value }
}

function diffSection(
  section: Evidence<TurnDiffSnapshotRecord[]>,
  dropped: Set<string>
): { section: Evidence<TurnDiffSnapshotRecord[]>; lost: boolean } {
  if (!section.value) return { section, lost: false }
  let lost = false
  const value = section.value.map((snapshot) => ({
    ...snapshot,
    files: snapshot.files.map((file) => {
      if (!file.patchContent?.contentRef || !dropped.has(file.patchContent.contentRef.sha256)) return file
      const body = degradeField(file.patchContent, dropped)
      lost ||= body.lost
      const patchContent = body.field
      return {
        ...file,
        ...(patchContent.content !== undefined ? { patch: patchContent.content } : {}),
        patchContent,
        patchStatus: patchContent.storage === 'complete'
          ? 'captured' as const
          : patchContent.content !== undefined ? 'truncated' as const : undefined
      }
    })
  }))
  return { section: lost ? degradedSection({ ...section, value }, CONTENT_ENVELOPE_REASON) : { ...section, value }, lost }
}

function assistantSection(
  section: Evidence<{ text?: string; textHash?: string; contentRefs?: ToolContentRef[] }>,
  dropped: Set<string>
): Evidence<{ text?: string; textHash?: string; contentRefs?: ToolContentRef[] }> {
  if (!section.value) return section
  const refs = withoutRefs(section.value, dropped)
  return refs.lost ? degradedSection({ ...section, value: refs.value }, CONTENT_ENVELOPE_REASON) : section
}

function transcriptSection(
  section: Evidence<TurnTranscriptSource> | undefined,
  dropped: Set<string>
): Evidence<TurnTranscriptSource> | undefined {
  if (!section?.value || !dropped.has(section.value.contentRef.sha256)) return section
  return {
    ...section,
    status: 'unavailable',
    quality: 'unavailable',
    value: undefined,
    omissionReason: CONTENT_ENVELOPE_REASON
  }
}

function applyDrops(record: RecordDraft, dropped: Set<string>): RecordDraft {
  return {
    ...record,
    tools: callsSection(record.tools, dropped),
    skills: callsSection(record.skills, dropped),
    mcps: callsSection(record.mcps, dropped),
    assistant: assistantSection(record.assistant, dropped),
    diff: diffSection(record.diff, dropped).section,
    ...(record.modelSegments ? { modelSegments: segmentsSection(record.modelSegments, dropped) } : {}),
    ...(record.transcript
      ? { transcript: transcriptSection(record.transcript, dropped) }
      : {})
  }
}

function shrinkInlineDiffBodies(record: RecordDraft, overBy: number): RecordDraft {
  const candidates: Array<{ snapshot: number; file: number; bytes: number }> = []
  for (const [snapshotIndex, snapshot] of (record.diff.value ?? []).entries()) {
    for (const [fileIndex, file] of snapshot.files.entries()) {
      if ((file.patchContent?.savedBytes ?? 0) > RECORDER_INLINE_PREVIEW_BYTES) {
        candidates.push({ snapshot: snapshotIndex, file: fileIndex, bytes: file.patchContent!.savedBytes })
      }
    }
  }
  if (candidates.length === 0) return record
  candidates.sort((left, right) => right.bytes - left.bytes)
  let remaining = overBy
  let next = record
  let lost = false
  for (const candidate of candidates) {
    if (remaining <= 0) break
    const snapshot = next.diff.value![candidate.snapshot]
    const file = snapshot.files[candidate.file]
    const field = file.patchContent!
    const target = Math.max(RECORDER_INLINE_PREVIEW_BYTES, field.savedBytes - remaining)
    const shrunk = limitToolContent(field, target, 'turn_budget')
    if (!shrunk.contentRef) lost = true
    remaining -= field.savedBytes - shrunk.savedBytes
    const files = [...snapshot.files]
    files[candidate.file] = {
      ...file,
      ...(shrunk.content !== undefined ? { patch: shrunk.content } : {}),
      patchContent: shrunk,
      ...(file.patchStatus === 'truncated' ? {} : { patchStatus: shrunk.contentRef ? 'captured' as const : 'truncated' as const })
    }
    const value = [...next.diff.value!]
    value[candidate.snapshot] = { ...snapshot, files }
    next = { ...next, diff: { ...next.diff, value } }
  }
  return lost ? { ...next, diff: degradedSection(next.diff, CONTENT_ENVELOPE_REASON) } : next
}

export function applyRecordContentBudget(record: RecordDraft): RecordDraft {
  const refs = recordContentRefs(record)
  const priorities = refPriorities(record)
  const kept = new Map<string, ToolContentRef>()
  const dropped = new Set<string>()
  for (const priority of RECORD_CONTENT_PRIORITY) {
    for (const ref of refs) {
      if (priorities.get(ref.sha256) !== priority || kept.has(ref.sha256) || dropped.has(ref.sha256)) continue
      if (ref.bytes > RECORDER_CONTENT_MAX_BYTES || kept.size >= RECORDER_CONTENT_MAX_REFS) dropped.add(ref.sha256)
      else kept.set(ref.sha256, ref)
    }
  }
  const recordJson = JSON.stringify(record)
  let size = envelopeBytes(recordJson, [...kept.values()])
  while (size > RECORDER_TRANSPORT_MAX_BYTES && kept.size > 0) {
    let victim: ToolContentRef | undefined
    for (let index = RECORD_CONTENT_PRIORITY.length - 1; index >= 0 && !victim; index--) {
      const priority = RECORD_CONTENT_PRIORITY[index]
      for (const ref of kept.values()) {
        if (priorities.get(ref.sha256) !== priority) continue
        if (!victim || ref.bytes > victim.bytes || (ref.bytes === victim.bytes && ref.sha256 < victim.sha256)) victim = ref
      }
    }
    if (!victim) break
    kept.delete(victim.sha256)
    dropped.add(victim.sha256)
    size = kept.size === 0
      ? envelopeBytes(recordJson, [])
      : size - base64Bytes(victim.bytes) - entryBytes(victim)
  }
  if (dropped.size === 0 && size <= RECORDER_TRANSPORT_MAX_BYTES) return record
  let next = dropped.size > 0 ? applyDrops(record, dropped) : record
  for (let pass = 0; pass < 4; pass++) {
    size = envelopeBytes(JSON.stringify(next), [...kept.values()])
    if (size <= RECORDER_TRANSPORT_MAX_BYTES) break
    const shrunk = shrinkInlineDiffBodies(next, size - RECORDER_TRANSPORT_MAX_BYTES)
    if (shrunk === next) break
    next = shrunk
  }
  return next
}
