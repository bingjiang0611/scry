import { readRecorderContent, writeRecorderContent } from './content-store.js'
import { type ToolContent, type ToolContentRef } from '../../shared/tool-content.js'
import { type Evidence, type EvidenceQuality, type EvidenceStatus, type TurnCall, type TurnEvidence } from '../../shared/turn-record.js'

export const CONTENT_MISSING_REASON = 'complete body missing from workspace recorder content store'

export function isDegradedContent(field: ToolContent | undefined): boolean {
  return field !== undefined && field.storage === 'omitted' &&
    field.sourceCompleteness === 'unavailable' && field.contentRef === undefined
}

function unavailableContent(field: ToolContent): ToolContent {
  const { content: _content, contentRef: _contentRef, ...rest } = field
  return {
    ...rest,
    savedBytes: 0,
    storage: 'omitted',
    sourceCompleteness: 'unavailable',
    reasons: [...new Set([...rest.reasons, 'not_collected' as const])]
  }
}

export function degradedSection<T extends { status: EvidenceStatus; quality: EvidenceQuality; omissionReason?: string }>(
  section: T,
  reason: string
): T {
  return {
    ...section,
    status: section.status === 'unavailable' ? 'unavailable' : 'partial',
    quality: section.quality === 'exact' ? 'inferred' : section.quality,
    omissionReason: [...new Set([...(section.omissionReason ? section.omissionReason.split('; ') : []), reason])].join('; ')
  }
}

export interface CaptureTrim {
  keepToolOutputBody: boolean
}

export interface ContentSectionPolicy {
  keepToolOutputBody: boolean
}

export interface ContentResolution {
  restored: number
  unavailable: number
}

export async function resolveContentSections<T extends TurnEvidence>(
  sections: T,
  dataRoot: string,
  policy: ContentSectionPolicy
): Promise<{ value: T; resolution: ContentResolution }> {
  const resolution: ContentResolution = { restored: 0, unavailable: 0 }
  const keepsOutputBody = policy.keepToolOutputBody
  const hasBody = async (ref: ToolContentRef): Promise<boolean> => {
    try {
      await readRecorderContent(dataRoot, ref)
      return true
    } catch {
      return false
    }
  }
  const durable = async (value: ToolContent | undefined): Promise<{ value?: ToolContent; lost: boolean }> => {
    if (!value) return { lost: false }
    if (value.contentRef && await hasBody(value.contentRef)) return { value, lost: false }
    if (value.storage === 'complete' && value.content !== undefined) {
      const contentRef = await writeRecorderContent(dataRoot, value.content, value.encoding === 'json' ? 'json' : 'utf8')
      resolution.restored++
      return { value: { ...value, contentRef }, lost: false }
    }
    if (value.contentRef || value.storage === 'complete') {
      resolution.unavailable++
      return { value: unavailableContent(value), lost: true }
    }
    return { value, lost: false }
  }

  const calls = async (section: Evidence<TurnCall[]>): Promise<Evidence<TurnCall[]>> => {
    if (!section.value) return section
    let lost = false
    const value = await Promise.all(section.value.map(async (call): Promise<TurnCall> => {
      const input = await durable(call.inputContent)
      lost ||= input.lost
      const kept: TurnCall = { ...call, ...(input.value ? { inputContent: input.value } : {}) }
      if (!keepsOutputBody) {
        const { outputContent: _dropped, ...summaryOnly } = kept
        return summaryOnly
      }
      const output = await durable(kept.outputContent)
      if (!output.lost) return { ...kept, ...(output.value ? { outputContent: output.value } : {}) }
      lost = true
      return {
        ...kept,
        outputContent: output.value!,
        outputSummary: undefined,
        ...(call.error !== undefined ? { error: 'tool failed' } : {})
      }
    }))
    return lost ? degradedSection({ ...section, value }, CONTENT_MISSING_REASON) : { ...section, value }
  }

  const refs = async (value: ToolContentRef[] | undefined): Promise<ToolContentRef[] | undefined> => {
    if (!value?.length) return value
    const kept = await Promise.all(value.map(hasBody))
    return kept.every(Boolean) ? value : undefined
  }

  const assistantRefs = await refs(sections.assistant.value?.contentRefs)
  let assistant = sections.assistant
  if (sections.assistant.value?.contentRefs && !assistantRefs) {
    resolution.unavailable++
    assistant = degradedSection(
      { ...sections.assistant, value: { ...sections.assistant.value, contentRefs: undefined } },
      CONTENT_MISSING_REASON
    )
  }

  let segmentLoss = false
  const modelSegments = sections.modelSegments?.value
    ? await Promise.all(sections.modelSegments.value.map(async (segment) => {
      const kept = await refs(segment.contentRefs)
      if (segment.contentRefs && !kept) {
        segmentLoss = true
        resolution.unavailable++
      }
      return kept ? segment : { ...segment, contentRefs: undefined }
    }))
    : undefined

  let patchLoss = false
  const diffValue = sections.diff.value
    ? await Promise.all(sections.diff.value.map(async (snapshot) => ({
      ...snapshot,
      files: await Promise.all(snapshot.files.map(async (file) => {
        const patch = await durable(file.patchContent)
        patchLoss ||= patch.lost
        return { ...file, ...(patch.value ? { patchContent: patch.value } : {}) }
      }))
    })))
    : undefined

  const transcriptDurable = sections.transcript?.value ? await hasBody(sections.transcript.value.contentRef) : true
  if (!transcriptDurable) resolution.unavailable++
  const [tools, skills, mcps] = await Promise.all([calls(sections.tools), calls(sections.skills), calls(sections.mcps)])
  const next = {
    ...sections,
    assistant,
    tools,
    skills,
    mcps,
    diff: patchLoss
      ? degradedSection({ ...sections.diff, ...(diffValue ? { value: diffValue } : {}) }, CONTENT_MISSING_REASON)
      : { ...sections.diff, ...(diffValue ? { value: diffValue } : {}) },
    ...(modelSegments
      ? {
        modelSegments: segmentLoss
          ? degradedSection({ ...sections.modelSegments!, value: modelSegments }, CONTENT_MISSING_REASON)
          : { ...sections.modelSegments!, value: modelSegments }
      }
      : {}),
    ...(sections.transcript
      ? {
        transcript: transcriptDurable ? sections.transcript : {
          ...sections.transcript,
          value: undefined,
          status: 'unavailable' as const,
          quality: 'unavailable' as const,
          omissionReason: [sections.transcript.omissionReason, CONTENT_MISSING_REASON].filter(Boolean).join('; ')
        }
      }
      : {})
  } as T
  return { value: next, resolution }
}

export async function applyCapturePolicy(
  evidence: TurnEvidence,
  dataRoot: string,
  trim: CaptureTrim
): Promise<TurnEvidence> {
  const { value } = await resolveContentSections(evidence, dataRoot, { keepToolOutputBody: trim.keepToolOutputBody })
  return value
}

export async function resolveRecordContentRefs<T extends TurnEvidence>(
  record: T,
  dataRoot: string
): Promise<{ record: T; resolution: ContentResolution }> {
  const { value, resolution } = await resolveContentSections(record, dataRoot, { keepToolOutputBody: true })
  return { record: value, resolution }
}
