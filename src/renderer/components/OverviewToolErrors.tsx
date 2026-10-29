// 总览里的工具报错证据：只展示已捕获的输入/输出，缺正文时读存档引用，而不是断言 Provider 未上报。
import { useEffect, useState, type ReactNode } from 'react'
import type { TraceEvent } from '@shared/trace'
import { isOverviewToolErrorEvent } from '@shared/logical-calls'
import type { ToolContent } from '@shared/tool-content'
import { OVERVIEW_TOOL_ERROR_COPY } from '../constants/copy'
import { CONTENT_PAGE_BYTES, RecorderContentPager, bytesFromBase64 } from './ChatTurnPager'
import { Icon } from './primitives/Icon'

// 归档正文按 sha256 内容寻址且不可变，按引用缓存摘要不会读到过期内容。
const ARCHIVED_MESSAGE_CACHE_ENTRIES = 128
const archivedMessageCache = new Map<string, string>()

export interface OverviewToolError {
  event: TraceEvent
  result: TraceEvent
  tool: string
  input: unknown
  output?: string
  /** 本轮正文预算用尽后只剩引用；引用可读，不等于 Provider 未上报。 */
  inputContent?: ToolContent
  outputContent?: ToolContent
  message: string
}

function nestedErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['error', 'message', 'detail']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key]
  }
  if (Array.isArray(record.content)) {
    const text = record.content
      .flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
        ? [(item as Record<string, unknown>).text as string]
        : [])
      .join('\n')
    if (text.trim()) return text
  }
  return undefined
}

function errorMessageFromOutput(output: string | undefined, content?: ToolContent): string {
  if (!output) {
    return content?.contentRef
      ? OVERVIEW_TOOL_ERROR_COPY.archived(content.contentRef.bytes)
      : OVERVIEW_TOOL_ERROR_COPY.noDetail
  }
  let detail = output
  try {
    detail = nestedErrorMessage(JSON.parse(output)) ?? output
  } catch {
    // 非 JSON 输出直接作为 Provider 的原始错误证据展示。
  }
  const normalized = detail
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized ? `${normalized.slice(0, 280)}${normalized.length > 280 ? '…' : ''}` : OVERVIEW_TOOL_ERROR_COPY.noDetail
}

export function overviewToolErrors(events: TraceEvent[]): OverviewToolError[] {
  const callsById = new Map<string, TraceEvent>()
  for (const event of events) {
    if (!event.toolUseId || event.stage === 'tool_result') continue
    const key = `${event.runId}\0${event.toolUseId}`
    const current = callsById.get(key)
    if (!current || (current.input == null && event.input != null)) callsById.set(key, event)
  }
  return events.filter(isOverviewToolErrorEvent).map((result) => {
    const call = result.toolUseId ? callsById.get(`${result.runId}\0${result.toolUseId}`) : undefined
    const output = result.output ?? result.text
    const tool = call?.isMcp
      ? call.mcpAction
        ? `${call.mcpServer ?? 'mcp'}.${call.mcpAction}`
        : call.mcpTool ?? call.mcpServer ?? 'MCP'
      : call?.tool ?? call?.name ?? result.tool ?? result.name ?? '工具'
    return {
      event: call ?? result,
      result,
      tool,
      input: call?.input,
      ...(output != null ? { output } : {}),
      ...(call?.inputContent ? { inputContent: call.inputContent } : {}),
      ...(result.outputContent ? { outputContent: result.outputContent } : {}),
      message: errorMessageFromOutput(output, result.outputContent)
    }
  })
}


function errorEvidenceText(value: unknown): string {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  const limit = 8_000
  return text.length > limit ? `${text.slice(0, limit)}\n\n… 已截断（原始 ${text.length} 字符）` : text
}

// 内联正文只在首次投影里存在；超出预算后只能靠归档引用读取。两项都缺才是 Provider 未上报。
function ToolErrorEvidenceField({
  label,
  pagerLabel,
  value,
  content,
  remote
}: {
  label: string
  pagerLabel: string
  value: unknown
  content?: ToolContent
  remote: boolean
}): ReactNode {
  const inline = value == null ? undefined : errorEvidenceText(value)
  const contentRef = content?.contentRef
  return (
    <div className="turn-tool-error-field">
      <span>{label}</span>
      {inline != null && <pre>{inline}</pre>}
      {contentRef
        ? <RecorderContentPager label={pagerLabel} contentRef={contentRef} source={content?.source} remote={remote} />
        : inline == null && <pre>{OVERVIEW_TOOL_ERROR_COPY.notReported}</pre>}
    </div>
  )
}

export function TurnToolErrorDetails({
  errors,
  onOpen,
  remote = false
}: {
  errors: OverviewToolError[]
  onOpen: (error: OverviewToolError) => void
  remote?: boolean
}): ReactNode {
  return (
    <div className="turn-tool-errors" aria-label="本轮工具报错详情">
      {errors.map((error, index) => (
        <ToolErrorCard error={error} key={`${error.result.id}:${index}`} onOpen={onOpen} remote={remote} />
      ))}
    </div>
  )
}

// 正文超出内联预算时只剩归档引用。报错摘要必须来自真实正文，所以卡片出现时就按引用读一页；
// 结果按内容哈希缓存（归档正文不可变），重复渲染/重挂载不再重复 IO。
function ToolErrorCard({
  error,
  onOpen,
  remote
}: {
  error: OverviewToolError
  onOpen: (error: OverviewToolError) => void
  remote: boolean
}): ReactNode {
  const outputRef = error.outputContent?.contentRef
  const outputSource = error.outputContent?.source
  const needsArchivedMessage = error.output == null && outputRef != null && !remote
  const [archivedMessage, setArchivedMessage] = useState<string | undefined>(
    () => (outputRef ? archivedMessageCache.get(outputRef.sha256) : undefined)
  )

  useEffect(() => {
    if (!needsArchivedMessage || archivedMessage != null || !outputRef) return
    let cancelled = false
    void (async () => {
      try {
        const page = await window.scry.recorderContentPage({
          ref: outputRef,
          offset: 0,
          limit: CONTENT_PAGE_BYTES,
          ...(outputSource === 'scry_app_trace' ? { source: 'app-trace' as const } : {})
        })
        // 跨页正文无法可靠解析成一条错误摘要，保留诚实的存档提示。
        if (page.hasMore) return
        const resolved = errorMessageFromOutput(new TextDecoder().decode(bytesFromBase64(page.dataBase64)), error.outputContent)
        if (archivedMessageCache.size >= ARCHIVED_MESSAGE_CACHE_ENTRIES) {
          const oldest = archivedMessageCache.keys().next().value
          if (oldest != null) archivedMessageCache.delete(oldest)
        }
        archivedMessageCache.set(outputRef.sha256, resolved)
        if (!cancelled) setArchivedMessage(resolved)
      } catch {
        // 观测附加路径：读不到就保留存档提示，不阻断正文分页。
      }
    })()
    return () => { cancelled = true }
  }, [archivedMessage, error.outputContent, needsArchivedMessage, outputRef, outputSource])

  const message = archivedMessage ?? error.message
  return (
    <details className="turn-tool-error">
      <summary title={message}>
        <strong><Icon name="x" />{error.tool}</strong>
        <span>{message}</span>
        <Icon name="chevronDown" className="turn-tool-error-chevron" />
      </summary>
      <div className="turn-tool-error-evidence">
        <div className="turn-tool-error-evidence-head">
          <span>{OVERVIEW_TOOL_ERROR_COPY.heading}</span>
          <button type="button" onClick={() => onOpen(error)}>{OVERVIEW_TOOL_ERROR_COPY.openInChat}</button>
        </div>
        <ToolErrorEvidenceField label={OVERVIEW_TOOL_ERROR_COPY.input} pagerLabel="input" value={error.input} content={error.inputContent} remote={remote} />
        <ToolErrorEvidenceField label={OVERVIEW_TOOL_ERROR_COPY.output} pagerLabel="output" value={error.output} content={error.outputContent} remote={remote} />
        <div className="turn-tool-error-field is-error">
          <span>{OVERVIEW_TOOL_ERROR_COPY.message}</span>
          <pre>{message}</pre>
        </div>
      </div>
    </details>
  )
}
