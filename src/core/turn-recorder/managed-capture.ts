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

export interface ContentSectionPolicy {
  keepToolOutputBody: boolean
}

/** 一次归一化的结果：写回本库的正文数量，以及被判为丢失（降级）的字段数量。 */
export interface ContentResolution {
  restored: number
  unavailable: number
}

/**
 * 记录与证据共用的唯一正文遍历：工具/技能/MCP 的入参与输出、助手与模型分段引用、diff 补丁、
 * transcript。`applyCapturePolicy`（准备阶段）与 `resolveRecordContentRefs`（提交边界）都走这里，
 * 新增正文字段只需在此登记一次，两个边界都不会漏检、把悬空引用写进正式记录。
 *
 * 只有“有引用但读不到字节”或“自称 complete 却没有任何正文”才算正文丢失；provider_missing、
 * truncated、omitted 是 Provider 或上游裁剪给出的既有含义，原样保留（连同 outputSummary），
 * 否则一次策略裁剪会被记成“Scry 丢正文”。
 */
export async function resolveContentSections<T extends TurnEvidence>(
  sections: T,
  dataRoot: string,
  policy: ContentSectionPolicy
): Promise<{ value: T; resolution: ContentResolution }> {
  const resolution: ContentResolution = { restored: 0, unavailable: 0 }
  const keepsOutputBody = policy.keepToolOutputBody
  // 任何读不回来都等于“无法证明这份正文”：文件不存在、权限不足、长度或摘要不符，都只能降级成
  // unavailable，不能让一次降级把整轮记录的准备与提交打断。校验失败的正文按缺失处理，记录里写清原因。
  const hasBody = async (ref: ToolContentRef): Promise<boolean> => {
    try {
      await readRecorderContent(dataRoot, ref)
      return true
    } catch {
      return false
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
      resolution.restored++
      return { value: { ...value, contentRef }, lost: false }
    }
    // A reference without readable bytes, or a claim of a complete body with nothing behind it,
    // is the only loss this policy reports.
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
  // Record envelopes carry fields this walker never rewrites; only the content sections are replaced.
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

/** 采集策略归一化（准备阶段）：按工作区策略裁剪，并保证保留下来的正文在本库可读。 */
export async function applyCapturePolicy(
  evidence: TurnEvidence,
  dataRoot: string,
  trim: CaptureTrim
): Promise<TurnEvidence> {
  const { value } = await resolveContentSections(evidence, dataRoot, { keepToolOutputBody: trim.keepToolOutputBody })
  return value
}

/**
 * 提交边界的不变式：正式记录里的每个引用都必须能在目标内容库解析。
 *
 * 可解析 → 放行；引用缺失但字段内还带着完整正文 → 先把字节写回本库；两者都不成立 → 走既有降级
 * 语义（unavailable + 分区 partial）。这条不变式独立于采集策略：旧的 handoff、恢复路径和重复提交
 * 都会经过它，因此绝不把只在别处（例如 App trace 库）存在字节的引用写进 `.scry/records`。
 */
export async function resolveRecordContentRefs<T extends TurnEvidence>(
  record: T,
  dataRoot: string
): Promise<{ record: T; resolution: ContentResolution }> {
  const { value, resolution } = await resolveContentSections(record, dataRoot, { keepToolOutputBody: true })
  return { record: value, resolution }
}
