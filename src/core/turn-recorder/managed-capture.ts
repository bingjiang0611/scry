import { readRecorderContent, writeRecorderContent } from './content-store.js'
import { type ToolContent, type ToolContentRef } from '../../shared/tool-content.js'
import { type Evidence, type EvidenceQuality, type EvidenceStatus, type TurnCall, type TurnEvidence } from '../../shared/turn-record.js'

/**
 * 记录必须能自我兑现：写进 `.scry/records` 的每个引用都要在本工作区 recorder 内容库里存在字节，
 * 而正文保留多少由工作区采集策略决定（工具入参始终保留，工具输出按 toolOutput 裁剪）。缺失的正文
 * 降级为 unavailable 并让所在分区标 partial，绝不保留悬空引用，也不把缺失写成空内容或抛错。
 */
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
  /** Tool output bodies are a promise of the full policy only; summary keeps the bounded summary. */
  keepToolOutputBody: boolean
}

/**
 * 只有“有引用但读不到字节”或“自称 complete 却没有任何正文”才算正文丢失；provider_missing、
 * truncated、omitted 是 Provider 或上游裁剪给出的既有含义，原样保留（连同 outputSummary），
 * 否则一次策略裁剪会被记成“Scry 丢正文”。
 */
export async function applyCapturePolicy(
  evidence: TurnEvidence,
  dataRoot: string,
  trim: CaptureTrim
): Promise<TurnEvidence> {
  const keepsOutputBody = trim.keepToolOutputBody
  const hasBody = async (ref: ToolContentRef): Promise<boolean> => {
    try {
      await readRecorderContent(dataRoot, ref)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  // A kept body must be durable here: persist the inline copy when the reference has no bytes, and
  // degrade only when this recorder cannot prove it holds the whole body. A truncated projection is
  // never promoted to a reference, because the reference would then claim more than its bytes.
  const durable = async (value: ToolContent | undefined): Promise<{ value?: ToolContent; lost: boolean }> => {
    if (!value) return { lost: false }
    if (value.contentRef && await hasBody(value.contentRef)) return { value, lost: false }
    if (value.storage === 'complete' && value.content !== undefined) {
      const contentRef = await writeRecorderContent(dataRoot, value.content, value.encoding === 'json' ? 'json' : 'utf8')
      return { value: { ...value, contentRef }, lost: false }
    }
    // A reference without readable bytes, or a claim of a complete body with nothing behind it,
    // is the only loss this policy reports.
    if (value.contentRef || value.storage === 'complete') return { value: unavailableContent(value), lost: true }
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
        // summary/none: the record keeps the bounded summary only. The body and its reference stay
        // in the App trace store, so the workspace store never receives the full tool output.
        const { outputContent: _dropped, ...summaryOnly } = kept
        return summaryOnly
      }
      const output = await durable(kept.outputContent)
      if (!output.lost) return { ...kept, ...(output.value ? { outputContent: output.value } : {}) }
      lost = true
      // The body is gone: the summary and error it produced cannot outlive it, and 'tool failed'
      // is the only claim the remaining evidence still supports.
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

  const assistantRefs = await refs(evidence.assistant.value?.contentRefs)
  const assistant = evidence.assistant.value?.contentRefs && !assistantRefs
    ? degradedSection(
      { ...evidence.assistant, value: { ...evidence.assistant.value, contentRefs: undefined } },
      CONTENT_MISSING_REASON
    )
    : evidence.assistant

  let segmentLoss = false
  const modelSegments = evidence.modelSegments?.value
    ? await Promise.all(evidence.modelSegments.value.map(async (segment) => {
      const kept = await refs(segment.contentRefs)
      if (segment.contentRefs && !kept) segmentLoss = true
      return kept ? segment : { ...segment, contentRefs: undefined }
    }))
    : undefined

  let patchLoss = false
  const diffValue = evidence.diff.value
    ? await Promise.all(evidence.diff.value.map(async (snapshot) => ({
      ...snapshot,
      files: await Promise.all(snapshot.files.map(async (file) => {
        const patch = await durable(file.patchContent)
        patchLoss ||= patch.lost
        return { ...file, ...(patch.value ? { patchContent: patch.value } : {}) }
      }))
    })))
    : undefined

  const transcriptDurable = evidence.transcript?.value ? await hasBody(evidence.transcript.value.contentRef) : true
  const [tools, skills, mcps] = await Promise.all([calls(evidence.tools), calls(evidence.skills), calls(evidence.mcps)])
  return {
    ...evidence,
    assistant,
    tools,
    skills,
    mcps,
    diff: patchLoss
      ? degradedSection({ ...evidence.diff, ...(diffValue ? { value: diffValue } : {}) }, CONTENT_MISSING_REASON)
      : { ...evidence.diff, ...(diffValue ? { value: diffValue } : {}) },
    ...(modelSegments
      ? { modelSegments: segmentLoss
        ? degradedSection({ ...evidence.modelSegments!, value: modelSegments }, CONTENT_MISSING_REASON)
        : { ...evidence.modelSegments!, value: modelSegments } }
      : {}),
    ...(evidence.transcript
      ? { transcript: transcriptDurable ? evidence.transcript : {
        ...evidence.transcript,
        value: undefined,
        status: 'unavailable' as const,
        quality: 'unavailable' as const,
        omissionReason: [evidence.transcript.omissionReason, CONTENT_MISSING_REASON].filter(Boolean).join('; ')
      } }
      : {})
  }
}
