import { type ToolContent, type ToolContentRef } from '../../shared/tool-content.js'
import type { AgentTurnRecord, Evidence, TurnCall, TurnDiffSnapshotRecord, TurnModelSegment, TurnTranscriptSource } from '../../shared/turn-record.js'
import { degradedSection } from './managed-capture.js'
import { recordContentItems } from './store-index.js'
import { limitToolContent } from './tool-content.js'

/**
 * Transport budget for one committed turn record.
 *
 * The receiver holds one decoding envelope, so the record JSON, every referenced body and their
 * base64/JSON framing must fit it together. Enforcing this only at the shared commit boundary keeps
 * the guarantee in one place: the App-managed path and the standalone CLI both publish through
 * `commitRecord`, and both may hand it references written earlier in the turn.
 */

/** Largest single body whose base64 still fits half the envelope, leaving room for the record. */
export const RECORDER_CONTENT_MAX_BYTES = 8 * 1024 * 1024
/** Distinct SHA-256 bodies one record may reference; the receiver rejects the 513th. */
export const RECORDER_CONTENT_MAX_REFS = 512
/** Complete decoded transport envelope: record JSON plus base64 content plus its JSON framing. */
export const RECORDER_TRANSPORT_MAX_BYTES = 16 * 1024 * 1024
/** Inline preview kept when a diff body is dropped or shrunk by this budget. */
export const RECORDER_INLINE_PREVIEW_BYTES = 8 * 1024
/** Same envelope shape the uploader validates before sending (`recorder-content-v1`). */
export const RECORDER_TRANSPORT_ENCODING = 'recorder-content-v1'
/** Reason recorded on a field or section whose complete body this budget dropped. */
export const CONTENT_ENVELOPE_REASON = 'record transport budget dropped complete bodies'

/** The budget is size-driven, so it applies to a prepared draft exactly as it does to a committed record. */
type RecordDraft = Omit<AgentTurnRecord, 'sequence'>

function base64Bytes(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}

/** A content entry occupies its JSON literal plus a separator; both grow by outer-string escaping. */
function entryBytes(ref: ToolContentRef): number {
  const literal = JSON.stringify({ sha256: ref.sha256, bytes: ref.bytes, dataBase64: '' })
  return Buffer.byteLength(JSON.stringify(literal)) - 2 + 1
}

/**
 * Exact decoded size of the uploader envelope without materializing base64: the content JSON is
 * serialized once with empty bodies, then each body's exact base64 length is added. Base64 uses no
 * character that JSON would escape, so the two parts stay additive.
 */
function envelopeBytes(recordJson: string, refs: readonly ToolContentRef[]): number {
  // The wrapper itself counts even when nothing is referenced: the receiver measures the envelope,
  // and escaping the record string into it is real bytes. Returning the bare record length here
  // would undercount exactly the case with no slack from base64.
  const contentJson = JSON.stringify(refs.map(({ sha256, bytes }) => ({ sha256, bytes, dataBase64: '' })))
  return Buffer.byteLength(JSON.stringify({ scryEncoding: RECORDER_TRANSPORT_ENCODING, recordJson, contentJson })) +
    refs.reduce((sum, ref) => sum + base64Bytes(ref.bytes), 0)
}

/** The bodies this record would transmit if nothing were dropped. */
export function recordContentRefs(record: RecordDraft): ToolContentRef[] {
  const refs = new Map<string, ToolContentRef>()
  for (const { ref } of recordContentItems(record)) {
    const previous = refs.get(ref.sha256)
    if (previous && previous.bytes !== ref.bytes) throw new Error(`conflicting recorder content reference: ${ref.sha256}`)
    if (!previous) refs.set(ref.sha256, ref)
  }
  return [...refs.values()]
}

/** Size the receiver will check: record JSON plus every referenced body in its transport encoding. */
export function recordTransportBytes(record: RecordDraft): number {
  return envelopeBytes(JSON.stringify(record), recordContentRefs(record))
}

function degradeField(field: ToolContent, dropped: Set<string>): { field: ToolContent; lost: boolean } {
  if (!field.contentRef || !dropped.has(field.contentRef.sha256)) return { field, lost: false }
  const { contentRef: _contentRef, ...rest } = field
  // A complete inline body already carries every byte the reference did: dropping only the
  // reference loses nothing, so the field keeps its status and gains no budget reason.
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
      // The patch status must stay truthful about what is now reachable from this record.
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

/** A transcript body has no inline preview and its reference is required, so a drop is unavailable. */
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

/**
 * Inline diff bodies are the only unbounded previews in a record (tool bodies are capped by the
 * turn budget, model previews by 32 KiB, and transcripts carry no inline copy). When references
 * alone could not bring the envelope down, shrink the largest patch previews, keeping the complete
 * body only where a retained reference still points at it.
 */
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
    // A shrunk body without a retained reference makes this patch incomplete, so the section can no
    // longer claim exact evidence: the record now holds a preview of a larger patch.
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

/**
 * Converge one record onto the transport budget. Returns the record unchanged when it already
 * fits, so the common path allocates nothing.
 */
export function applyRecordContentBudget(record: RecordDraft): RecordDraft {
  const refs = recordContentRefs(record)
  const kept = new Map<string, ToolContentRef>()
  const dropped = new Set<string>()
  for (const ref of refs) {
    if (ref.bytes > RECORDER_CONTENT_MAX_BYTES || kept.size >= RECORDER_CONTENT_MAX_REFS) dropped.add(ref.sha256)
    else kept.set(ref.sha256, ref)
  }
  const recordJson = JSON.stringify(record)
  let size = envelopeBytes(recordJson, [...kept.values()])
  while (size > RECORDER_TRANSPORT_MAX_BYTES && kept.size > 0) {
    // Base64 dominates the envelope, so the largest body buys the most room per lost reference.
    const victim = [...kept.values()].reduce((largest, ref) =>
      ref.bytes > largest.bytes || (ref.bytes === largest.bytes && ref.sha256 < largest.sha256) ? ref : largest)
    kept.delete(victim.sha256)
    dropped.add(victim.sha256)
    size = kept.size === 0
      ? envelopeBytes(recordJson, [])
      : size - base64Bytes(victim.bytes) - entryBytes(victim)
  }
  if (dropped.size === 0 && size <= RECORDER_TRANSPORT_MAX_BYTES) return record
  let next = dropped.size > 0 ? applyDrops(record, dropped) : record
  // Dropping references cannot shrink inline bodies; bound those too rather than commit an envelope
  // the receiver would reject. A retained reference still points at the complete body.
  for (let pass = 0; pass < 4; pass++) {
    size = envelopeBytes(JSON.stringify(next), [...kept.values()])
    if (size <= RECORDER_TRANSPORT_MAX_BYTES) break
    const shrunk = shrinkInlineDiffBodies(next, size - RECORDER_TRANSPORT_MAX_BYTES)
    if (shrunk === next) break
    next = shrunk
  }
  return next
}
