// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { latestBackgroundWork } from '@shared/background-work'
import { backgroundWorkStatus } from '../background-work-status'
import { BackgroundWorkPanel } from './BackgroundWorkPanel'
import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'
import type { HookConfiguredCommand, TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import type { ContentRef, RecorderContentPage } from '@shared/tool-content'
import { isOverviewToolErrorEvent } from '@shared/logical-calls'
import {
  isIncompleteRunTermination,
  normalizeAgentQuestionRequest,
  runTerminationHint,
  runTerminationLabel,
  type AgentIntervention,
  type AgentInputAttachment,
  type AgentQuestionRequest,
  type AgentQuestionResponse,
  type RunTerminationReason
} from '@shared/runtime'
import { AskUserQuestionInline, AskUserQuestionResult } from './AskUserQuestionDialog'
import { ModalFrame } from './Modals'
import {
  aggregateCalls,
  aggregateHooks,
  aggregateFiles,
  basename,
  fileBadge,
  fmtTok,
  hookCancellationDetail,
  hookCommandLabel,
  logicalCallEventsForTurn,
  parseUserMessage,
  resultOf,
  resultTokenTotal,
  toolArg,
  toolDisplayName,
  toolMeta
} from '../format'
import type { FileRow, HookGroup, HookScriptRow, HookSummary, Turn } from '../format'
import { displayDiffPath, editActionLineCounts, turnDiffViewOf } from '../turn-diff'
import { TurnStreamProjectionCache, isStreamTextFragment } from '../turn-stream-projection'

function runtimeTitleForTurn(turn: Turn): { avatar: string; label: string } {
  const event = turn.items.find((item) => item.providerId || item.runtimeProvider)
  const raw = event?.providerId ?? event?.runtimeProvider?.replace(/_(sdk|cli|server)$/, '') ?? 'agent'
  const label = raw.charAt(0).toUpperCase() + raw.slice(1)
  return { avatar: label.charAt(0), label }
}

// 用户消息：① 斜杠命令 → 气泡内 .slash chip；② skill 注入(claude code 塞的 SKILL.md，非用户输入)
// → 中性折叠注记，不当蓝气泡；③ 普通文本/命令 → 蓝色右对齐气泡 + markdown + 超长折叠。
// 附件 data URL 只按对象身份构造一次：单张图最多 10MiB，重复拼 base64 字符串会在
// 每次渲染（尤其流式期高频重渲染）产生数 MB 的临时字符串。WeakMap 随附件对象一起回收。
const attachmentSrcCache = new WeakMap<AgentInputAttachment, string>()
export function attachmentSrc(attachment: AgentInputAttachment): string {
  const cached = attachmentSrcCache.get(attachment)
  if (cached != null) return cached
  const src = `data:${attachment.mimeType};base64,${attachment.dataBase64}`
  attachmentSrcCache.set(attachment, src)
  return src
}

function ImageLightbox({ attachment, onClose }: { attachment: AgentInputAttachment; onClose: () => void }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [zoom, setZoom] = useState(1)
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const [fit, setFit] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const stage = stageRef.current
    const image = imageRef.current
    if (!stage || !image) return
    const resize = (): void => {
      if (!image.naturalWidth || !image.naturalHeight) return
      const ratio = Math.min(1, stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight)
      setFit({ width: image.naturalWidth * ratio, height: image.naturalHeight * ratio })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(stage)
    image.addEventListener('load', resize)
    resize()
    return () => {
      observer.disconnect()
      image.removeEventListener('load', resize)
    }
  }, [])
  // Transcript turns use content-visibility containment: fixed overlays must escape
  // their clipping/stacking context without disabling long-history rendering optimizations.
  return createPortal(
    <ModalFrame labelledBy={titleId} initialFocusRef={closeRef} className="image-lightbox" onClose={onClose}>
      <h2 id={titleId} className="visually-hidden">{attachment.name}</h2>
      <button ref={closeRef} type="button" className="image-lightbox-close" onClick={onClose} aria-label="关闭图片预览">
        <Icon name="x" />
      </button>
      <div ref={stageRef} className="image-lightbox-stage" tabIndex={0} aria-label="图片内容，可滚动查看">
        <img
          ref={imageRef}
          src={attachmentSrc(attachment)}
          alt={attachment.name}
          decoding="async"
          style={{ width: fit ? fit.width * zoom : undefined, height: fit ? fit.height * zoom : undefined, visibility: fit ? 'visible' : 'hidden' }}
        />
      </div>
      <div className="image-lightbox-zoom" aria-label="图片缩放（相对于适应窗口）">
        <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} disabled={zoom <= 0.5} aria-label="缩小图片">
          <Icon name="minus" />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((value) => Math.min(2, value + 0.25))} disabled={zoom >= 2} aria-label="放大图片">
          <Icon name="plus" />
        </button>
      </div>
    </ModalFrame>,
    document.body
  )
}

export type UserMessageEditMode = 'branch' | 'restart'

function UserMessageImpl({
  text,
  attachments = [],
  editable = false,
  editMode = 'branch',
  onEdit
}: {
  text: string
  attachments?: AgentInputAttachment[]
  editable?: boolean
  editMode?: UserMessageEditMode
  onEdit?: (text: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState<AgentInputAttachment | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const skillDetailId = useId()
  if (!text && attachments.length === 0) return null
  const { command, body, injectedSkill } = parseUserMessage(text)

  if (editing) {
    const submit = async (): Promise<void> => {
      const prompt = draft.trim()
      if (!prompt || saving || !onEdit) return
      setSaving(true)
      setEditError(null)
      try {
        await onEdit(prompt)
        setEditing(false)
      } catch (error) {
        setEditError(error instanceof Error ? error.message : String(error))
      } finally {
        setSaving(false)
      }
    }
    return (
      <div className="turn-user editing">
        <div className="bubble-user user-edit-bubble">
          <textarea
            className="user-edit-input"
            value={draft}
            autoFocus
            aria-label="编辑最后一条消息"
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(text)
                setEditError(null)
                setEditing(false)
              } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          {editError && <div className="user-edit-error" role="alert">{editError}</div>}
          <div className="user-edit-footer">
            <span className="user-edit-note">
              {editMode === 'branch'
                ? '将创建新对话分支，不会回滚工作区文件'
                : '当前会话尚未形成可分支边界；发送后将从此消息重新开始，不会回滚工作区文件'}
            </span>
            <div className="user-edit-actions">
              <button type="button" disabled={saving} onClick={() => { setDraft(text); setEditError(null); setEditing(false) }}>取消</button>
              <button
                type="button"
                className="primary"
                title="发送修改后的消息并建立新分支"
                disabled={saving || !draft.trim()}
                onClick={() => void submit()}
              >
                {saving ? '发送中…' : '发送'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // skill 注入：不是用户发的，渲染成中性折叠注记（默认收起，点开看 SKILL.md）
  if (injectedSkill) {
    const lineCount = body.split('\n').length
    return (
      <div className="skillinject">
        <button type="button" className="si-head" aria-expanded={expanded} aria-controls={skillDetailId} onClick={() => setExpanded((v) => !v)}>
          <Icon name="box" /> 注入 skill 内容 · <b>{injectedSkill}</b> · {lineCount} 行{' '}
          <span className="dim">（claude code 自动注入，非用户输入）</span>
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className="chev" />
        </button>
        {expanded && (
          <div id={skillDetailId} className="md si-body">
            <Markdown>{body}</Markdown>
          </div>
        )}
      </div>
    )
  }

  // 普通用户输入 / 命令 → 蓝色右对齐气泡（命令走气泡内 .slash chip）
  const lines = body ? body.split('\n') : []
  const long = lines.length > 12 || body.length > 800
  const shown = long && !expanded ? lines.slice(0, 10).join('\n') : body
  return (
    <div className="turn-user">
      <div className="bubble-user">
        {command && (
          <div className="slash">
            <Icon name="box" /> {command}
          </div>
        )}
        {body && (
          <div className="md user-md">
            <Markdown>{shown}</Markdown>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="user-attachments" aria-label="发送的图片">
            {attachments.map((attachment, index) => (
              <button
                type="button"
                className="user-attachment"
                key={`${attachment.name}:${attachment.size}:${index}`}
                onClick={() => setPreview(attachment)}
                aria-label={`放大查看图片 ${attachment.name}`}
              >
                <img src={attachmentSrc(attachment)} alt="" loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        )}
        {long && (
          <button
            type="button"
            className="expandbtn"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name={expanded ? 'chevronUp' : 'chevronDown'} />
            <span>{expanded ? '收起' : '展开全部'}</span>
            {!expanded && <span className="expandmeta">{lines.length} 行</span>}
          </button>
        )}
      </div>
      {editable && onEdit && (
        <div className="user-message-actions">
          <button
            type="button"
            className="user-message-edit"
            aria-label="编辑最后一条消息"
            title={editMode === 'branch' ? '编辑最后一条消息并从这里建立新分支' : '编辑最后一条消息并重新开始'}
            onClick={() => { setDraft(text); setEditError(null); setEditing(true) }}
          >
            <Icon name="edit" />
          </button>
        </div>
      )}
      {preview && <ImageLightbox attachment={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

/**
 * Provider adapters may deliver reasoning token-by-token. Keep one disclosure per
 * contiguous model stream, including old archived traces that predate reducer coalescing.
 */
export function coalesceAdjacentThinking(items: readonly TraceEvent[]): TraceEvent[] {
  const out: TraceEvent[] = []
  for (const event of items) {
    const previous = out[out.length - 1]
    const sameStream =
      previous?.kind === 'model' && event.kind === 'model' &&
      previous.stage === 'thinking' && event.stage === 'thinking' &&
      previous.messageId === event.messageId &&
      previous.agentId === event.agentId &&
      previous.parentToolUseId === event.parentToolUseId
    if (sameStream) {
      out[out.length - 1] = {
        ...previous,
        thinking: `${previous.thinking ?? ''}${event.thinking ?? ''}`
      }
    } else {
      out.push(event)
    }
  }
  return out
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(true)
  if (!text.trim()) return null
  return (
    <details className="thinking" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="think-head" aria-expanded={open}>
        <Icon name="bulb" className="think-bulb" />
        <span>思考过程</span>
        <Icon name="chevronDown" className="think-chevron" />
      </summary>
      {open && <div className="think-text md"><Markdown>{text}</Markdown></div>}
    </details>
  )
}

function fmtDur(ms?: number): string {
  if (ms == null) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function cancellationStatus(detail: NonNullable<ReturnType<typeof hookCancellationDetail>>): string {
  const label = detail.kind === 'timeout' ? '超时终止' : detail.kind === 'suspected-timeout' ? '疑似超时' : '已取消'
  if (detail.durationMs == null) return label
  const limit = detail.timeoutMs == null
    ? ''
    : ` / ${detail.timeoutSource === 'current-config' ? '当前配置上限' : '上限'} ${fmtDur(detail.timeoutMs)}`
  return `${label} · ${fmtDur(detail.durationMs)}${limit}`
}

function hookCommandFromTrace(event: TraceEvent): string | undefined {
  if (event.hookCommand) return event.hookCommand
  const input = event.input as Record<string, unknown> | undefined
  return typeof input?.command === 'string' && input.command.trim() ? input.command.trim() : undefined
}

function unsuccessfulHookStatus(event: TraceEvent): string {
  const cancellation = hookCancellationDetail(event)
  if (cancellation) return cancellationStatus(cancellation)
  const input = event.input as Record<string, unknown> | undefined
  const exitCode = event.hookExitCode ?? (typeof input?.exitCode === 'number' ? input.exitCode : undefined)
  return exitCode == null ? '执行失败' : `执行失败 · exit ${exitCode}`
}

const CONTENT_PAGE_BYTES = 64 * 1024
const CONTENT_PAGE_CACHE = 8

type DisplayContentPage = RecorderContentPage & { text: string }

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function RecorderContentPager({ label, contentRef }: { label: string; contentRef: ContentRef }) {
  const [pages, setPages] = useState<DisplayContentPage[]>([])
  const [cursor, setCursor] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const decoderRef = useRef(new TextDecoder())
  const generationRef = useRef(0)

  useEffect(() => {
    generationRef.current += 1
    setPages([])
    setCursor(-1)
    setLoading(false)
    setError(undefined)
    decoderRef.current = new TextDecoder()
  }, [contentRef.sha256])

  const load = useCallback(async (offset: number) => {
    const generation = generationRef.current
    setLoading(true)
    setError(undefined)
    try {
      const page = await window.scry.recorderContentPage({ ref: contentRef, offset, limit: CONTENT_PAGE_BYTES })
      if (generation !== generationRef.current) return
      const text = decoderRef.current.decode(bytesFromBase64(page.dataBase64), { stream: page.hasMore })
      setPages((current) => {
        const next = [...current, { ...page, text }].slice(-CONTENT_PAGE_CACHE)
        setCursor(next.length - 1)
        return next
      })
    } catch (reason) {
      if (generation === generationRef.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [contentRef])

  const page = pages[cursor]
  return (
    <div className="recorder-content-page">
      {!page ? (
        <button type="button" onClick={() => void load(0)} disabled={loading}>
          {loading ? '正在读取…' : `查看完整 ${label} · ${contentRef.bytes.toLocaleString()} bytes`}
        </button>
      ) : (
        <>
          <div className="lbl">完整 {label} · bytes {page.offset}–{page.nextOffset} / {page.totalBytes}</div>
          <pre>{page.text}</pre>
          <div className="recorder-content-page-actions">
            <button type="button" disabled={cursor <= 0 || loading} onClick={() => setCursor((value) => value - 1)}>上一页</button>
            <button
              type="button"
              disabled={loading || (cursor >= pages.length - 1 && !page.hasMore)}
              onClick={() => {
                if (cursor < pages.length - 1) setCursor((value) => value + 1)
                else void load(page.nextOffset)
              }}
            >{loading ? '正在读取…' : '下一页'}</button>
          </div>
        </>
      )}
      {error && <div role="alert">完整正文读取失败：{error}</div>}
    </div>
  )
}

// 蓝本 .tool-card：状态(check/x) · 工具名 · op(R/W/E) · arg · meta(dur/tok/danger) · chev；点开内联展开 tool-detail。
function ToolItem({
  ev,
  selected,
  onSelect,
  maxDur,
  pendingQuestion,
  intervention,
  queuedQuestionCount = 0,
  onAnswerQuestion,
  onOpenFileDiff,
  turnDone = false
}: {
  ev: TraceEvent
  selected: boolean
  onSelect: () => void
  maxDur: number
  pendingQuestion?: AgentQuestionRequest
  intervention?: AgentIntervention
  queuedQuestionCount?: number
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  onOpenFileDiff?: () => void
  turnDone?: boolean
}) {
  const isAskUserQuestion = ev.tool === 'AskUserQuestion' || !!intervention
  const detailId = useId()
  const [open, setOpen] = useState(isAskUserQuestion)
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string>>()
  const meta = toolMeta(ev)
  const op = ev.fileOp === 'read' ? 'r' : ev.fileOp === 'write' ? 'w' : ev.fileOp === 'edit' ? 'e' : null
  const inp = ev.input as Record<string, unknown> | undefined
  const isEdit = ev.tool === 'Edit' && (typeof inp?.old_string === 'string' || typeof inp?.new_string === 'string')
  const editLines = isEdit ? editActionLineCounts(ev.input) : null
  const questionRequest = useMemo(
    () =>
      pendingQuestion ??
      intervention?.request ??
      (isAskUserQuestion && ev.toolUseId
        ? normalizeAgentQuestionRequest(ev.runId, ev.toolUseId, ev.input, ev.agentId)
        : null),
    [ev.agentId, ev.input, ev.runId, ev.toolUseId, intervention, isAskUserQuestion, pendingQuestion]
  )
  const waitingForAnswer = !!pendingQuestion
  const interventionFailed = !!intervention && intervention.resolution !== 'answered'
  const waitingForQuestionState =
    !turnDone && isAskUserQuestion && !!questionRequest && !ev.output && !ev.isError && !submittedAnswers && !intervention
  const missingQuestionResult =
    turnDone && isAskUserQuestion && !!questionRequest && !ev.output && !ev.isError && !submittedAnswers && !intervention
  const lockedOpen = waitingForAnswer || waitingForQuestionState
  const hasDetail = ev.input != null || !!ev.output || !!questionRequest || !!ev.inputContent?.contentRef || !!ev.outputContent?.contentRef
  const shownOpen = lockedOpen || open
  const kind = ev.isError ? 'err' : ev.isMcp ? 'mcp' : ev.kind
  const displayName = toolDisplayName(ev)
  const durPct = ev.durationMs != null ? Math.max(3, Math.round((ev.durationMs / maxDur) * 100)) : 0
  return (
    <div
      className={`tool-card k-${kind} ${selected ? 'selected' : ''} ${ev.agentId || ev.parentToolUseId ? 'sub' : ''}`}
      data-trace-event-id={ev.id}
    >
      <button
        type="button"
        className="tool-row"
        aria-expanded={hasDetail ? shownOpen : undefined}
        aria-controls={hasDetail ? detailId : undefined}
        title={onOpenFileDiff ? '点开工具输入，同时在右侧 Diff 中定位该文件的本轮改动' : undefined}
        onClick={() => {
          onSelect()
          onOpenFileDiff?.()
          if (hasDetail && !lockedOpen) setOpen((v) => !v)
        }}
      >
        <span className={`st ${lockedOpen || missingQuestionResult ? 'pending' : ev.isError || interventionFailed ? 'err' : 'ok'}`}>
          <Icon name={lockedOpen ? 'clock' : missingQuestionResult ? 'alert' : ev.isError || interventionFailed ? 'x' : 'check'} />
        </span>
        <span className="name" title={displayName}>{displayName}</span>
        {(kind === 'skill' || kind === 'mcp' || kind === 'agent') && <span className={`kindtag ${kind}`} />}
        {op && <span className={`op ${op}`}>{op.toUpperCase()}</span>}
        <span className="arg">{toolArg(ev)}</span>
        <span className="meta">
          {editLines && (
            <span
              className="tok edit-lines"
              title={`本次 Edit 工具输入：写入 new_string ${editLines.added} 行、替换掉 old_string ${editLines.deleted} 行。不是本轮 Git 净改动${onOpenFileDiff ? '；点卡片看本轮该文件的净 Diff' : ''}`}
            >
              <b className="add">+{editLines.added}</b>
              <b className="del">−{editLines.deleted}</b>
            </span>
          )}
          {ev.durationMs != null && <span className="dur">{fmtDur(ev.durationMs)}</span>}
          {durPct > 0 && (
            <span className={`bar ${durPct >= 70 ? 'slow' : ''}`} aria-hidden="true">
              <i style={{ width: `${durPct}%` }} />
            </span>
          )}
          {meta && <span className="tok">{meta}</span>}
          {ev.isMcp && <span className="tok" title={ev.mcpServer}>mcp:{ev.mcpServer}</span>}
          {waitingForAnswer && <span className="question-waiting">等待回答</span>}
          {!waitingForAnswer && waitingForQuestionState && <span className="question-waiting">等待状态同步</span>}
          {missingQuestionResult && <span className="question-waiting">未获得返回</span>}
          {ev.danger && (
            <span className={ev.danger.level === 'danger' ? 'danger' : 'warn'} title={ev.danger.reason}>
              <span className={`sdot ${ev.danger.level === 'danger' ? 'bad' : 'warn'}`} />
            </span>
          )}
        </span>
        {hasDetail && !lockedOpen && <Icon name={shownOpen ? 'chevronUp' : 'chevronDown'} className="chev" />}
      </button>
      {shownOpen && hasDetail && (
        <div id={detailId} className="tool-detail-region">
        {waitingForAnswer && questionRequest && onAnswerQuestion ? (
          <AskUserQuestionInline
            request={questionRequest}
            queuedCount={queuedQuestionCount}
            onRespond={onAnswerQuestion}
            onSubmitted={setSubmittedAnswers}
          />
        ) : isAskUserQuestion && questionRequest && (!!submittedAnswers || !!ev.output || !!ev.isError || !!intervention) ? (
          <AskUserQuestionResult
            request={questionRequest}
            answers={intervention?.response.behavior === 'answered' ? intervention.response.answers : submittedAnswers}
            output={ev.output}
            error={ev.isError}
            resolution={intervention?.resolution}
            durationMs={intervention?.durationMs}
            source={intervention?.source}
          />
        ) : (
          <div className="tool-detail">
            {isEdit ? (
              <>
                {typeof inp?.old_string === 'string' && (
                  <>
                    <div className="lbl">old_string</div>
                    <pre>{inp.old_string}</pre>
                  </>
                )}
                {typeof inp?.new_string === 'string' && (
                  <>
                    <div className="lbl">new_string</div>
                    <pre>{inp.new_string}</pre>
                  </>
                )}
              </>
            ) : ev.input != null ? (
              <>
                <div className="lbl">input</div>
                <pre>{JSON.stringify(ev.input, null, 2)}</pre>
              </>
            ) : null}
            {ev.inputContent?.contentRef && <RecorderContentPager label="input" contentRef={ev.inputContent.contentRef} />}
            {ev.output && (
              <>
                <div className="lbl">output{ev.isError ? ' · error' : ''}</div>
                <pre>{ev.output.slice(0, 4000)}</pre>
              </>
            )}
            {ev.outputContent?.contentRef && <RecorderContentPager label="output" contentRef={ev.outputContent.contentRef} />}
          </div>
        )}
        </div>
      )}
    </div>
  )
}

// 方案 C：一段连续的工具调用退成脚注——收起时只显示计数徽章 + 工具名列表 + 耗时，
// 点开抽屉展示原有 tool-card 明细。有待回答的 AskUserQuestion 时强制展开，避免藏住输入。
function toolGroupSummary(events: TraceEvent[]): { names: string[]; dur?: number; failed: number; count: number } {
  const counts = new Map<string, number>()
  for (const ev of events) {
    const name = toolDisplayName(ev)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
  const dur = events.every((ev) => ev.durationMs != null)
    ? events.reduce((sum, ev) => sum + ev.durationMs!, 0)
    : undefined
  const failed = events.filter((ev) => ev.isError).length
  return { names, dur, failed, count: events.length }
}

function ToolGroup({
  events,
  forceOpen = false,
  reveal = false,
  children
}: {
  events: TraceEvent[]
  forceOpen?: boolean
  reveal?: boolean
  children: ReactNode
}) {
  const bodyId = useId()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (reveal) setOpen(true)
  }, [reveal])
  const shownOpen = forceOpen || open
  const { names, dur, failed, count } = toolGroupSummary(events)
  const single = count === 1 ? events[0] : null
  const label = single ? `${toolDisplayName(single)}  ${toolArg(single)}`.trim() : names.join(' · ')
  return (
    <div className={shownOpen ? 'tool-group open' : 'tool-group'}>
      <button
        type="button"
        className="tool-group-row"
        aria-expanded={shownOpen}
        aria-controls={bodyId}
        onClick={() => !forceOpen && setOpen((v) => !v)}
      >
        <span className={failed ? 'tg-pill bad' : 'tg-pill'}>{count}</span>
        <span className="tg-label" title={label}>{label}</span>
        <span className="tg-rule" />
        {failed > 0 && <span className="tg-fail">{failed} 失败</span>}
        {dur != null && <span className="tg-dur" title="工具调用耗时合计">{fmtDur(dur)}</span>}
        <Icon name={shownOpen ? 'chevronUp' : 'chevronDown'} className="chev" />
      </button>
      <div id={bodyId} className="tool-group-body" hidden={!shownOpen}>
        {children}
      </div>
    </div>
  )
}

// P1（RFC §8.1 NIT-2）：subagent 的内部步骤（text/thinking/工具，parentToolUseId=父 Task tool_use_id）
// 默认折叠进父 Task 卡，避免多 subagent 会话主时间线被碎碎念淹没（forwardSubagentText 的本意是嵌套面板）。
function SubagentBlock({
  items,
  selectedId,
  onSelect,
  pendingQuestions = [],
  interventions = [],
  onAnswerQuestion,
  turnDone = false,
  liveText = '',
  liveKey: liveTailKey = ''
}: {
  items: TraceEvent[]
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
  pendingQuestions?: AgentQuestionRequest[]
  interventions?: AgentIntervention[]
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  turnDone?: boolean
  liveText?: string
  liveKey?: string
}) {
  const visibleItems = useMemo(
    () => coalesceAdjacentThinking(logicalCallEventsForTurn(items)),
    [items]
  )
  const hasPendingQuestion = visibleItems.some((event) =>
    pendingQuestions.some((request) => request.runId === event.runId && request.questionId === event.toolUseId)
  )
  const [open, setOpen] = useState(hasPendingQuestion)
  const bodyId = useId()
  useEffect(() => {
    if (hasPendingQuestion) setOpen(true)
  }, [hasPendingQuestion])
  const toolN = aggregateCalls(visibleItems).totalCalls
  const maxDur = Math.max(1, ...visibleItems.map((e) => e.durationMs ?? 0))
  return (
    <div className="subagent">
      <button type="button" className="subhead" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((current) => (hasPendingQuestion ? true : !current))}>
        <Icon name="cube" /> 子 agent 内部 · {toolN} 工具 / {items.length} 步{' '}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} className="chev" />
      </button>
      {open && (
        <div id={bodyId} className="subbody">
          {(() => {
            const out: ReactNode[] = []
            let live = ''
            let liveKey = ''
            const flushLive = (): void => {
              if (!live) return
              out.push(
                <div className="model-text md sub" key={liveKey || `sub-live-${out.length}`}>
                  <Markdown streaming={!turnDone}>{live}</Markdown>
                </div>
              )
              live = ''
              liveKey = ''
            }
            for (const ev of visibleItems) {
              if (ev.kind === 'model' && ev.stage === 'text_delta') {
                if (!live) liveKey = ev.id
                live += ev.text ?? ''
                continue
              }
              if (ev.kind === 'model' && ev.stage === 'thinking') {
                flushLive()
                out.push(<ThinkingBlock key={ev.id} text={ev.thinking ?? ''} />)
                continue
              }
              if (ev.kind === 'model' && ev.stage === 'text') {
                flushLive()
                if (ev.text) {
                  out.push(
                    <div className="model-text md sub" key={ev.id}>
                      <Markdown>{ev.text}</Markdown>
                    </div>
                  )
                }
                continue
              }
              flushLive()
              const pendingQuestion = pendingQuestions.find(
                (request) => request.runId === ev.runId && request.questionId === ev.toolUseId
              )
              out.push(
                <ToolItem
                  key={ev.id}
                  ev={ev}
                  selected={selectedId === ev.id}
                  onSelect={() => onSelect(ev)}
                  maxDur={maxDur}
                  pendingQuestion={pendingQuestion}
                  intervention={interventions.find((item) => item.request.questionId === ev.toolUseId)}
                  queuedQuestionCount={pendingQuestions.length}
                  onAnswerQuestion={onAnswerQuestion}
                  turnDone={turnDone}
                />
              )
            }
            flushLive()
            if (liveText) {
              out.push(
                <div className="model-text md sub streaming" key={liveTailKey || 'subagent-live-tail'}>
                  <Markdown streaming={!turnDone}>{liveText}</Markdown>
                </div>
              )
            }
            return out
          })()}
        </div>
      )}
    </div>
  )
}

function FilesSummary({
  structured,
  turnDiff,
  preview = false,
  onOpenDiff
}: {
  structured: FileRow[]
  turnDiff?: TurnDiffSnapshot
  /** true = 运行中的临时 Git 快照，本轮结束后会被终态取代。 */
  preview?: boolean
  onOpenDiff?: (initialPath?: string) => void
}) {
  const diffMode = turnDiff?.status === 'captured'
  const diffFiles = diffMode ? turnDiff.files : []
  const added = diffFiles.reduce((sum, file) => sum + file.added, 0)
  const deleted = diffFiles.reduce((sum, file) => sum + file.deleted, 0)
  const w = structured.filter((f) => f.write > 0).length
  const e = structured.filter((f) => f.edit > 0).length
  const r = structured.filter((f) => f.read > 0 && f.write === 0 && f.edit === 0).length
  const unavailableLabel = turnDiff?.status === 'timeout'
    ? `Git 差异采集超时 · ${(turnDiff.captureMs / 1000).toFixed(1)}s`
    : turnDiff?.status === 'failed'
      ? 'Git 差异采集失败'
      : turnDiff?.reason === 'not_git'
        ? '非 Git 目录'
        : turnDiff?.reason === 'no_head'
          ? 'Git 仓库尚无 HEAD'
          : undefined
  const structuredScope = 'R/W/E 来自结构化文件工具；~R 来自 cat、sed、rg 等只读 Bash 命令推断；其他 Bash/MCP/Hook 间接文件操作仍可能未统计'
  return (
    <details className={diffMode ? 'files-summary diff' : 'files-summary'}>
      <summary
        onClick={(event) => {
          if (!diffMode || !onOpenDiff) return
          event.preventDefault()
          onOpenDiff()
        }}
        title={diffMode
          ? preview
            ? '运行中的临时 Git 快照：本轮开始 → 此刻的净变化，本轮结束后会被终态快照取代'
            : '本轮开始/结束 Git 工作树快照的净变化；同目录外部并发修改也会计入，ignored 文件不统计'
          : `${structuredScope}${turnDiff ? `；精确行数不可用：${turnDiff.reason ?? turnDiff.status}` : ''}`}
      >
        <Icon name="file" /> {diffMode ? (preview ? '本轮改动（运行中预览）' : '本轮改动') : '本轮文件（工具证据）'}
        {diffMode ? (
          <>
            <span className="fh-file-count">{diffFiles.length} files</span>
            <span className="fh-count diff-count">
              <b className="add">+{added}</b>
              <b className="del">−{deleted}</b>
            </span>
            {onOpenDiff && (
              <span className="fh-review">
                Review <Icon name="chevronRight" />
              </span>
            )}
          </>
        ) : (
          <span className="fh-count">
            {r > 0 && (
              <span>
                R · <b className="r">{r}</b>
              </span>
            )}
            {w > 0 && (
              <span>
                W · <b className="w">{w}</b>
              </span>
            )}
            {e > 0 && (
              <span>
                E · <b className="e">{e}</b>
              </span>
            )}
            {unavailableLabel && <span className="line-unavailable">{unavailableLabel}</span>}
          </span>
        )}
        {(diffMode || structured.length > 0) && <span className="fh-total">{diffMode ? diffFiles.length : structured.length}</span>}
      </summary>
      <div className="files-body">
        {diffMode ? (
          diffFiles.length > 0 ? (
            diffFiles.map((file) => (
              <button
                type="button"
                className="file-row diff-row"
                key={file.path}
                title={`${file.path} · 在右侧 Review 中打开`}
                onClick={() => onOpenDiff?.(file.path)}
              >
                <span className="path">{displayDiffPath(file.path, turnDiff?.repoRoot)}</span>
                <span className="line-diff">
                  {file.binary ? (
                    <span className="binary">binary</span>
                  ) : (
                    <>
                      <b className="add">+{file.added}</b>
                      <b className="del">−{file.deleted}</b>
                    </>
                  )}
                </span>
                {onOpenDiff && <Icon name="chevronRight" className="diff-row-open" />}
              </button>
            ))
          ) : (
            <div className="files-empty">无净改动</div>
          )
        ) : (
          structured.length > 0 ? (
            structured.map((f) => (
              <div className="file-row" key={f.path} title={f.path}>
                <span className={`op ${fileBadge(f).toLowerCase()}`}>{fileBadge(f)}</span>
                <span className="path">{basename(f.path)}</span>
                {f.inferredRead > 0 && <span className="dim">~R{f.inferredRead}</span>}
              </div>
            ))
          ) : (
            <div className="files-empty">暂无文件工具证据</div>
          )
        )}
      </div>
    </details>
  )
}

interface TurnHookTriggerRow {
  trigger: string
  toolCalls: number
  displayedRuns: number
  exactConfiguredMapping: boolean
}

interface TurnHookScript extends HookScriptRow {
  configuredCommands: HookConfiguredCommand[]
  displayedRuns: number
  triggerRows: TurnHookTriggerRow[]
  exactConfiguredMapping: boolean
}

interface TurnHookPhase {
  event: string
  logicalRuns: number
  responses: number
  pending: number
  errors: number
  cancelled: number
  triggerRuns: number | null
  scripts: TurnHookScript[]
}

interface HookPhaseTiming {
  durationMs: number
  timedInstances: number
  totalInstances: number
}

function latestHookEvent(a: TraceEvent | undefined, b: TraceEvent | undefined): TraceEvent | undefined {
  if (!a) return b
  if (!b) return a
  const aTime = Date.parse(a.ts)
  const bTime = Date.parse(b.ts)
  if (!Number.isFinite(aTime)) return b
  if (!Number.isFinite(bTime)) return a
  return bTime >= aTime ? b : a
}

function uniqueHookCommands(commands: HookConfiguredCommand[]): HookConfiguredCommand[] {
  const seen = new Set<string>()
  return commands.filter((candidate) => {
    const key = `${candidate.source}\0${candidate.sourcePath}\0${candidate.command}\0${candidate.matcher ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function configuredCommandsForScript(script: HookScriptRow): HookConfiguredCommand[] {
  if (script.command) return []
  return uniqueHookCommands([
    ...script.instances.flatMap((instance) => instance.configuredCommands),
    ...(script.last?.hookConfiguredCommands ?? [])
  ])
}

function hookTriggerRow(group: HookGroup, script: HookScriptRow, configuredCommands: HookConfiguredCommand[]): TurnHookTriggerRow {
  const exactConfiguredMapping =
    !script.command &&
    script.pending === 0 &&
    group.toolCalls > 0 &&
    configuredCommands.length > 0 &&
    group.toolCalls * configuredCommands.length === script.logicalRuns
  return {
    trigger: group.trigger,
    toolCalls: group.toolCalls,
    displayedRuns: exactConfiguredMapping ? group.toolCalls : script.logicalRuns,
    exactConfiguredMapping
  }
}

function aggregateTurnHookPhases(summary: HookSummary): TurnHookPhase[] {
  const phases = new Map<string, TurnHookPhase & { scriptsByHandler: Map<string, TurnHookScript> }>()
  for (const group of summary.groups) {
    let phase = phases.get(group.event)
    if (!phase) {
      phase = {
        event: group.event,
        logicalRuns: 0,
        responses: 0,
        pending: 0,
        errors: 0,
        cancelled: 0,
        triggerRuns: null,
        scripts: [],
        scriptsByHandler: new Map()
      }
      phases.set(group.event, phase)
    }
    phase.logicalRuns += group.logicalRuns
    phase.responses += group.responses
    phase.pending += group.pending
    phase.errors += group.errors
    phase.cancelled += group.cancelled
    if (group.triggerRuns != null) phase.triggerRuns = (phase.triggerRuns ?? 0) + group.triggerRuns

    for (const script of group.scripts) {
      const configuredCommands = configuredCommandsForScript(script)
      const triggerRow = hookTriggerRow(group, script, configuredCommands)
      const handlerKey = script.command ? `command:${script.command}` : `unmapped:${script.key}`
      const existing = phase.scriptsByHandler.get(handlerKey)
      if (!existing) {
        phase.scriptsByHandler.set(handlerKey, {
          ...script,
          key: `${group.event}\0${handlerKey}`,
          configuredCommands,
          displayedRuns: triggerRow.displayedRuns,
          triggerRows: [triggerRow],
          exactConfiguredMapping: triggerRow.exactConfiguredMapping
        })
        continue
      }

      const last = latestHookEvent(existing.last, script.last)
      const lastError = latestHookEvent(existing.lastError, script.lastError)
      const lastCancelled = latestHookEvent(existing.lastCancelled, script.lastCancelled)
      phase.scriptsByHandler.set(handlerKey, {
        ...existing,
        rawEvents: existing.rawEvents + script.rawEvents,
        logicalRuns: existing.logicalRuns + script.logicalRuns,
        responses: existing.responses + script.responses,
        pending: existing.pending + script.pending,
        started: existing.started + script.started,
        progress: existing.progress + script.progress,
        errors: existing.errors + script.errors,
        cancelled: existing.cancelled + script.cancelled,
        outcome: last?.hookOutcome ?? (last === script.last ? script.outcome : existing.outcome),
        exitCode: last?.hookExitCode ?? (last === script.last ? script.exitCode : existing.exitCode),
        last,
        lastError,
        lastCancelled,
        unsuccessful: [...existing.unsuccessful, ...script.unsuccessful],
        failureSummary: lastError === script.lastError ? script.failureSummary : existing.failureSummary,
        instances: [...existing.instances, ...script.instances],
        configuredCommands: uniqueHookCommands([...existing.configuredCommands, ...configuredCommands]),
        displayedRuns: existing.displayedRuns + triggerRow.displayedRuns,
        triggerRows: [...existing.triggerRows, triggerRow],
        exactConfiguredMapping: existing.exactConfiguredMapping && triggerRow.exactConfiguredMapping
      })
    }
  }

  return [...phases.values()].map(({ scriptsByHandler, ...phase }) => ({
    ...phase,
    scripts: [...scriptsByHandler.values()].sort(
      (a, b) => b.displayedRuns - a.displayedRuns || a.label.localeCompare(b.label)
    )
  }))
}

function formatHookPhaseDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const seconds = Math.round(ms / 1_000)
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function hookPhaseTiming(phase: TurnHookPhase): HookPhaseTiming | undefined {
  const instances = new Map<string, HookScriptRow['instances'][number]>()
  for (const instance of phase.scripts.flatMap((script) => script.instances)) {
    const previous = instances.get(instance.key)
    if (!previous || previous.durationMs == null && instance.durationMs != null) instances.set(instance.key, instance)
  }
  const intervals = [...instances.values()].flatMap((instance): Array<[number, number]> => {
    let end = instance.completedAtMs
    if (end == null && instance.last.stage === 'hook_response') {
      const timestamp = Date.parse(instance.last.ts)
      if (Number.isFinite(timestamp)) end = timestamp
    }
    let start = instance.startedAtMs
    if (end != null && instance.durationMs != null && instance.durationSource === 'provider') {
      start = end - instance.durationMs
    }
    return start != null && end != null && end >= start ? [[start, end]] : []
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (intervals.length === 0) return undefined

  let durationMs = 0
  let [start, end] = intervals[0]
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd)
    } else {
      durationMs += end - start
      start = nextStart
      end = nextEnd
    }
  }
  return { durationMs: durationMs + end - start, timedInstances: intervals.length, totalInstances: instances.size }
}

export function HooksSummary({
  summary,
  title = '本轮 Hook',
  defaultExpanded = false
}: {
  summary: HookSummary
  title?: string
  defaultExpanded?: boolean
}) {
  const phases = aggregateTurnHookPhases(summary)
  const detailValue = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  const scopeLabel = (source: HookConfiguredCommand['source']): string =>
    source === 'user' ? '用户' : source === 'project' ? '项目' : source === 'local' ? '本地' : '插件'

  return (
    <details className="turn-hooks-summary" open={defaultExpanded}>
      <summary>
        <Icon name="tool" /> {title}
        <span className="hook-total">{phases.length} 个周期 · {summary.logicalRuns} 个处理器实例</span>
      </summary>
      <div className="turn-hooks-body">
        {phases.map((phase, phaseIndex) => {
          const phaseTone = phase.errors > 0 ? 'bad' : phase.cancelled > 0 || phase.pending > 0 ? 'warn' : 'ok'
          const timing = hookPhaseTiming(phase)
          const timingLabel = timing ? `耗时 ~${formatHookPhaseDuration(timing.durationMs)}` : '耗时 —'
          const timingTitle = timing
            ? `周期占用墙钟约 ${formatHookPhaseDuration(timing.durationMs)}；按 ${timing.timedInstances}/${timing.totalInstances} 个处理器实例的运行区间合并去重，并行实例不重复计时。`
            : '未获得可配对的 Hook 开始与结束时间，无法可靠计算周期耗时。'
          return (
            <details className="turn-hook-phase" key={phase.event} open={defaultExpanded}>
              <summary className="turn-hook-phase-row">
                <span className="hook-phase-order">{String(phaseIndex + 1).padStart(2, '0')}</span>
                <span className={`sdot ${phaseTone}`} />
                <span className="hook-phase-event">{phase.event}</span>
                <span className="hook-phase-stats">
                  <span className="hook-phase-duration" title={timingTitle}>{timingLabel}</span>
                  <span
                    className="hook-phase-count"
                    title="触发次数优先按唯一工具调用 ID 统计；无法关联工具时，仅在各处理器实例数一致时推导。右侧数字是处理器实例数。"
                  >
                    {phase.triggerRuns != null && <>{phase.triggerRuns} 次触发 · </>}
                    {phase.logicalRuns} 个处理器实例
                  </span>
                </span>
                <Icon name="chevronRight" className="hook-row-chev" />
              </summary>
              <div className="turn-hook-phase-body">
                {phase.scripts.map((script) => {
            const cancellation = hookCancellationDetail(script.lastCancelled)
            const unsuccessfulErrors = Math.max(
              script.errors,
              script.unsuccessful.filter((event) => event.hookOutcome !== 'cancelled').length
            )
            const hasErrors = unsuccessfulErrors > 0
            const tone = hasErrors ? 'bad' : script.cancelled > 0 ? 'warn' : script.responses > 0 ? 'ok' : 'warn'
            const cancellationLabel = cancellation?.kind === 'timeout'
              ? '超时'
              : cancellation?.kind === 'suspected-timeout' ? '疑似超时' : '已取消'
            const status = hasErrors
              ? `失败 ${unsuccessfulErrors}`
              : script.cancelled > 0
                ? script.cancelled < script.responses ? `取消 ${script.cancelled}` : `${cancellationLabel} ${script.cancelled}`
                : script.responses > 0 ? `成功 ${script.responses}` : `运行中 ${script.pending}`
            const statusDetail = cancellation
              ? `${script.cancelled < script.responses ? '部分取消；最近一次：' : ''}${cancellationStatus(cancellation)}`
              : status
            const latest = script.lastError ?? script.lastCancelled ?? script.last
            const configuredCommands = script.configuredCommands
            const triggerSubjects = [...new Set(script.triggerRows.map((row) => {
              const triggerPrefix = `${phase.event}:`
              return row.trigger.startsWith(triggerPrefix) ? row.trigger.slice(triggerPrefix.length) : row.trigger
            }))]
            const triggerLabel = triggerSubjects.length === 1
              ? triggerSubjects[0] === phase.event ? '周期' : triggerSubjects[0]
              : `${triggerSubjects[0]} +${triggerSubjects.length - 1}`
            const triggerSummary = script.triggerRows
              .filter((row) => row.toolCalls > 0)
              .map((row) => {
                const triggerPrefix = `${phase.event}:`
                const subject = row.trigger.startsWith(triggerPrefix) ? row.trigger.slice(triggerPrefix.length) : row.trigger
                return `${row.toolCalls} 次 ${subject}`
              })
              .join(' · ')
            const input = latest?.input as Record<string, unknown> | undefined
            const evidenceCandidates = [
              ['stdout', detailValue(input?.stdout)],
              ['stderr', detailValue(input?.stderr)],
              ['content', detailValue(input?.content)],
              ['output', detailValue(latest?.output)],
              ['text', detailValue(latest?.text)]
            ].filter((entry): entry is [string, string] => !!entry[1])
            const seenEvidence = new Set<string>()
            const evidence = evidenceCandidates.filter(([, value]) => {
              if (seenEvidence.has(value)) return false
              seenEvidence.add(value)
              return true
            })
            const successfulResponses = Math.max(0, script.responses - script.unsuccessful.length)
            const executionResult = [
              successfulResponses > 0 ? `${successfulResponses} 成功` : '',
              script.cancelled > 0 ? `${script.cancelled} 取消` : '',
              unsuccessfulErrors > 0 ? `${unsuccessfulErrors} 失败` : '',
              script.pending > 0 ? `${script.pending} 未结束` : ''
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <details className="turn-hook-item" key={script.key} open={defaultExpanded}>
                <summary className="turn-hook-row" title={`${phase.event} · ${triggerSubjects.join('、')}`}>
                  <span className={`sdot ${tone}`} />
                  <span className="hook-script-name">{script.label}</span>
                  <span className="hook-event-name">{triggerLabel}</span>
                  <span className={`hook-run-status ${tone}`}>{status}</span>
                  <span className="hook-run-count">{script.displayedRuns}×</span>
                  <Icon name="chevronRight" className="hook-row-chev" />
                </summary>
                <div className="turn-hook-detail">
                  <dl className="hook-detail-grid">
                    {triggerSummary && (
                      <>
                        <dt>工具调用</dt>
                        <dd>{triggerSummary}</dd>
                      </>
                    )}
                    <dt>执行结果</dt>
                    <dd>{executionResult || '暂无结果'}</dd>
                    <dt>最近结果</dt>
                    <dd>
                      {statusDetail}
                      {script.cancelled === 0 && script.exitCode != null ? ` · exit ${script.exitCode}` : ''}
                    </dd>
                    {script.cancelled > 0 && (
                      <>
                        <dt>影响</dt>
                        <dd>Hook 进程未正常完成；不代表对应工具调用也被取消。</dd>
                      </>
                    )}
                  </dl>
                  {script.unsuccessful.length > 0 && (
                    <div className="hook-issues-block">
                      <div className="hook-detail-label">未成功的 Hook · {script.unsuccessful.length}</div>
                      <div className="hook-issues-list">
                        {script.unsuccessful.map((issue) => {
                          const issueCommand = hookCommandFromTrace(issue)
                          const issueLabel = hookCommandLabel(issueCommand) ?? '命令未上报'
                          const issueTone = issue.hookOutcome === 'cancelled' ? 'warn' : 'bad'
                          const candidateCount = issue.hookConfiguredCommands?.length ?? configuredCommands.length
                          return (
                            <div className={`hook-issue ${issueTone}`} key={issue.hookId ?? issue.id}>
                              <div className="hook-issue-head">
                                <span className={`hook-run-status ${issueTone}`}>{unsuccessfulHookStatus(issue)}</span>
                                <strong>{issueLabel}</strong>
                              </div>
                              {issueCommand ? (
                                <code>{issueLabel}</code>
                              ) : (
                                <p>
                                  运行时未上报命令，无法可靠映射到{candidateCount > 0 ? `下方 ${candidateCount} 条当前配置` : '具体脚本'}。
                                </p>
                              )}
                              <div className="hook-issue-meta">hookId {issue.hookId ?? '未上报'}</div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {configuredCommands.length > 0 && (
                    <div className="hook-configured-block">
                      <div className="hook-detail-label">
                        {script.exactConfiguredMapping ? `每次并行触发的 Hook · ${configuredCommands.length} 个` : `当前配置匹配 · ${configuredCommands.length} 条`}
                      </div>
                      {!script.exactConfiguredMapping && (
                        <p className="hook-configured-note">
                          运行时未上报 Hook 与工具调用的逐实例映射；当前配置无法完整解释实际数量。配置可能在会话结束后变化，以下为当前配置反查。
                        </p>
                      )}
                      <div className="hook-configured-list">
                        {configuredCommands.map((candidate, index) => (
                          <div className="hook-configured-command" key={`${candidate.source}:${candidate.pluginId ?? ''}:${candidate.matcher ?? ''}:${candidate.command}:${index}`}>
                            <span className={`hook-config-scope ${candidate.source}`}>
                              {scopeLabel(candidate.source)}{candidate.pluginId ? ` · ${candidate.pluginId.split('@')[0]}` : ''}
                            </span>
                            <code>{hookCommandLabel(candidate.command) ?? 'command'}</code>
                            {(candidate.matcher || candidate.timeoutSeconds != null) && (
                              <span className="hook-config-matcher">
                                {candidate.matcher ? `matcher ${candidate.matcher}` : ''}
                                {candidate.matcher && candidate.timeoutSeconds != null ? ' · ' : ''}
                                {candidate.timeoutSeconds != null ? `timeout ${candidate.timeoutSeconds}s` : ''}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {evidence.length > 0 && (
                    <div className="hook-evidence-list">
                      {evidence.map(([label, value]) => (
                        <div className="hook-evidence" key={label}>
                          <div className="hook-detail-label">{label}</div>
                          <pre>{value}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            )
                })}
              </div>
            </details>
          )
        })}
      </div>
    </details>
  )
}

// 蓝本 .turn-footer：in / out / cache·r / cache·w / dur / api / tools / files / err，分组用 .sep 隔。
function TurnFooter({ items }: { items: TraceEvent[] }) {
  const result = resultOf({ items })
  const calls = logicalCallEventsForTurn(items)
  const tools = aggregateCalls(calls).totalCalls
  const reads = calls.filter((e) => e.stage !== 'tool_result' && e.fileOp === 'read').length
  const writes = calls.filter(
    (e) => e.stage !== 'tool_result' && (e.fileOp === 'write' || e.fileOp === 'edit')
  ).length
  const errs = items.filter((e) => e.stage === 'tool_result' && e.isError).length
  const interventions = items.flatMap((event) => event.intervention ? [event.intervention] : [])
    .filter((intervention) => intervention.resolution !== 'provider_cancelled')
  const questions = interventions.reduce((total, intervention) => total + intervention.request.questions.length, 0)
  if (!result && tools === 0 && interventions.length === 0) return null
  const stat = (lbl: string, val: ReactNode, cls = ''): ReactNode => (
    <span className={`stat ${cls}`}>
      <span className="lbl">{lbl}</span> <b>{val}</b>
    </span>
  )
  const hasUsage = result?.tokensIn != null || result?.tokensOut != null || !!result?.cacheReadTokens || !!result?.cacheCreationTokens
  const hasTiming = result?.durationMs != null || result?.durationApiMs != null
  return (
    <div className="turn-footer">
      {result?.tokensIn != null && stat('in', fmtTok(result.tokensIn))}
      {result?.tokensOut != null && stat('out', fmtTok(result.tokensOut))}
      {result?.cacheReadTokens ? stat('cache·r', fmtTok(result.cacheReadTokens)) : null}
      {result?.cacheCreationTokens ? stat('cache·w', fmtTok(result.cacheCreationTokens)) : null}
      {hasUsage && hasTiming && <span className="sep" />}
      {result?.durationMs != null && stat('dur', `${(result.durationMs / 1000).toFixed(1)}s`)}
      {result?.durationApiMs != null && stat('api', `${(result.durationApiMs / 1000).toFixed(1)}s`)}
      <span className="sep" />
      {stat('tools', tools)}
      {reads + writes > 0 && stat('files', `${reads} R · ${writes} W`)}
      {interventions.length > 0 && stat('human', `${interventions.length} · ${questions}Q`)}
      {errs > 0 && (
        <>
          <span className="sep" />
          {stat('err', errs, 'err')}
        </>
      )}
    </div>
  )
}

export function TerminationNotice({ reason }: { reason: RunTerminationReason }) {
  if (!isIncompleteRunTermination(reason)) return null
  return (
    <div className="termination-notice" role="status">
      <Icon name="alert" />
      <div>
        <b>{runTerminationLabel(reason)}</b>
        <span>{runTerminationHint(reason)}</span>
      </div>
    </div>
  )
}

function AssistantTurnImpl({
  turn,
  selectedId,
  onSelect,
  onOpenDiff,
  onForkTurn,
  pendingQuestions = [],
  onAnswerQuestion
}: {
  turn: Turn
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
  onOpenDiff?: (turn: Turn, turnDiff: TurnDiffSnapshot, initialPath?: string) => void
  onForkTurn?: (turn: Turn) => Promise<void>
  pendingQuestions?: AgentQuestionRequest[]
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
}) {
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  // 长轮次流式期把「还在增长的尾部文本」与结构化事件分开：只有结构真的变了才重算
  // 下面这些 O(全部事件) 的投影，纯 token 增量只更新一个字符串。
  const projectionCache = useRef<TurnStreamProjectionCache>()
  if (!projectionCache.current) projectionCache.current = new TurnStreamProjectionCache()
  const backgroundWork = !turn.done && !turn.error ? latestBackgroundWork(turn.items) : undefined
  const backgroundStatus = backgroundWorkStatus(backgroundWork)
  const terminal = turn.done || !!turn.error || backgroundStatus?.waiting === true
  const projection = projectionCache.current.project(turn.items)
  const structuralItems = projection.structuralItems as TraceEvent[]
  // 把 tool_result 合并进对应 tool_use（加 output），并从流里过滤掉单独的 tool_result 事件
  const items = useMemo(() => {
    const results = new Map<string, TraceEvent>()
    for (const e of structuralItems) if (e.stage === 'tool_result' && e.toolUseId) results.set(e.toolUseId, e)
    return structuralItems
      .filter((e) => e.stage !== 'tool_result')
      .map((e) => {
        const r = e.toolUseId && (e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent')
          ? results.get(e.toolUseId)
          : undefined
        return r ? { ...e, output: r.text, isError: r.isError ?? e.isError, durationMs: r.durationMs ?? e.durationMs } : e
      })
  }, [structuralItems])
  const visibleItems = useMemo(
    () => coalesceAdjacentThinking(logicalCallEventsForTurn(items)),
    [items]
  )
  const result = resultOf({ items })
  const canFork = Boolean(
    onForkTurn && turn.done && !turn.error && turn.providerTurnId && (turn.forkTurnId ?? turn.providerTurnId)
  )
  const forkAtTurn = async (): Promise<void> => {
    if (!onForkTurn || forking) return
    setForking(true)
    setForkError(null)
    try {
      await onForkTurn(turn)
    } catch (error) {
      setForkError(error instanceof Error ? error.message : String(error))
    } finally {
      setForking(false)
    }
  }
  const turnDiffView = turnDiffViewOf(items)
  const turnDiff = turnDiffView?.turnDiff
  const turnDiffPreview = turnDiffView?.preview === true
  const diffPaths = useMemo(
    () => new Set(turnDiff?.status === 'captured' ? turnDiff.files.map((file) => file.path) : []),
    [turnDiff]
  )
  // 轮次跑完且该文件真的出现在本轮 Git 快照里，才把工具卡接到同一个 Diff 面板；
  // 运行中或该文件没有净改动时不给假入口。
  const openFileDiffFor = useCallback((event: TraceEvent): (() => void) | undefined => {
    if (!onOpenDiff || !turnDiff || !turn.done) return undefined
    const path = event.filePath
    if (!path || !diffPaths.has(path)) return undefined
    return () => onOpenDiff(turn, turnDiff, path)
  }, [diffPaths, onOpenDiff, turn, turnDiff])
  const { structured } = useMemo(() => aggregateFiles(items), [items])
  const hookSummary = useMemo(() => aggregateHooks(items), [items])
  const hasFiles =
    structured.length > 0 ||
    (turnDiff?.status === 'captured' && turnDiff.files.length > 0) ||
    turnDiff?.status === 'timeout' ||
    turnDiff?.status === 'failed'
  const maxDur = useMemo(() => {
    let max = 1
    for (const event of visibleItems) {
      if (event.kind !== 'tool' && event.kind !== 'skill' && event.kind !== 'agent') continue
      max = Math.max(max, event.durationMs ?? 0)
    }
    return max
  }, [visibleItems])
  const toolN = useMemo(() => aggregateCalls(visibleItems).totalCalls, [visibleItems])
  const errs = useMemo(() => structuralItems.filter(isOverviewToolErrorEvent).length, [structuralItems])
  const runtime = runtimeTitleForTurn(turn)
  // P1：subagent 内部步骤（parentToolUseId 指向父 Task tool_use）按父分组，折叠进父 Task 卡
  const childrenByParent = useMemo(() => {
    const m = new Map<string, TraceEvent[]>()
    for (const ev of visibleItems) {
      if (ev.parentToolUseId) {
        const arr = m.get(ev.parentToolUseId) ?? []
        arr.push(ev)
        m.set(ev.parentToolUseId, arr)
      }
    }
    return m
  }, [visibleItems])
  const { knownToolUseIds, topLevelToolUseIds, interventions, interventionsByQuestionId, itemRunIds } = useMemo(() => {
    const known = new Set<string>()
    const topLevel = new Set<string>()
    const interventionList: NonNullable<TraceEvent['intervention']>[] = []
    const interventionMap = new Map<string, NonNullable<TraceEvent['intervention']>>()
    const runIds = new Set<string>()
    for (const event of visibleItems) {
      runIds.add(event.runId)
      if (event.intervention) {
        interventionList.push(event.intervention)
        interventionMap.set(event.intervention.request.questionId, event.intervention)
      }
      if (!event.toolUseId || (event.kind !== 'tool' && event.kind !== 'skill' && event.kind !== 'agent')) continue
      known.add(event.toolUseId)
      if (!event.parentToolUseId) topLevel.add(event.toolUseId)
    }
    return {
      knownToolUseIds: known,
      topLevelToolUseIds: topLevel,
      interventions: interventionList,
      interventionsByQuestionId: interventionMap,
      itemRunIds: runIds
    }
  }, [visibleItems])
  const pendingQuestionKeys = useMemo(
    () => new Set(pendingQuestions.map((request) => `${request.runId}\0${request.questionId}`)),
    [pendingQuestions]
  )
  const renderedPendingQuestionKeys = new Set(
    visibleItems
      .filter(
        (event) =>
          (!event.parentToolUseId || !knownToolUseIds.has(event.parentToolUseId) || topLevelToolUseIds.has(event.parentToolUseId)) &&
          pendingQuestionKeys.has(`${event.runId}\0${event.toolUseId}`)
      )
      .map((event) => `${event.runId}\0${event.toolUseId}`)
  )
  const unmatchedPendingQuestions = pendingQuestions.filter(
    (request) =>
      (request.runId === turn.runId || itemRunIds.has(request.runId)) &&
      !renderedPendingQuestionKeys.has(`${request.runId}\0${request.questionId}`)
  )
  // C1：合并连续 text_delta；旧版 Codex 曾把每个流式增量误标成 text，这里兼容已在途的旧事件。
  // 遇到可见事件就落成独立段，保留模型说明与工具调用的真实顺序。
  // 完整 text 块只替换当前尚未落盘的流式片段，避免整轮进度被拼成一个超长段落。
  // 尾部还在增长的顶层流式文本不进这里：它单独渲染，所以纯 token 增量不会重建整条时间线。
  const turnFlowBody = useMemo(() => {
      const out: ReactNode[] = []
      let live = ''
      let liveKey = ''
      const flushLive = (streaming = false): void => {
        if (!live) return
        flushTools()
        out.push(
          <div className={`model-text md${streaming ? ' streaming' : ''}`} key={liveKey || `live-${out.length}`}>
            <Markdown streaming={streaming}>{live}</Markdown>
          </div>
        )
        live = ''
        liveKey = ''
      }
      // 方案 C：把连续的 tool/skill/agent 攒进一组，遇到 text/thinking 或收尾再落成一个折叠的 ToolGroup。
      let toolBuf: { ev: TraceEvent; node: ReactNode }[] = []
      function flushTools(): void {
        if (toolBuf.length === 0) return
        const buf = toolBuf
        toolBuf = []
        const forceOpen = buf.some(({ ev }) =>
          ev.tool === 'AskUserQuestion' ||
          (ev.toolUseId ? interventionsByQuestionId.has(ev.toolUseId) : false) ||
          pendingQuestions.some((request) => request.runId === ev.runId && request.questionId === ev.toolUseId)
        )
        out.push(
          <ToolGroup
            key={`tg-${buf[0].ev.id}`}
            events={buf.map((b) => b.ev)}
            forceOpen={forceOpen}
            reveal={buf.some(({ ev }) =>
              ev.id === selectedId ||
              (ev.toolUseId ? childrenByParent.get(ev.toolUseId)?.some((child) => child.id === selectedId) : false)
            )}
          >
            {buf.map((b) => b.node)}
          </ToolGroup>
        )
      }
      for (const ev of visibleItems) {
        if (ev.kind === 'harness') continue
        // 只有父调用真实存在时才折叠。Provider 给出孤儿 parent id 时，仍按顶层事件渲染，
        // 避免一条坏归因把后续根 agent 内容整段吞掉。
        if (ev.parentToolUseId && knownToolUseIds.has(ev.parentToolUseId)) continue
        if (isStreamTextFragment(ev)) {
          if (!live) liveKey = ev.id
          live += ev.text ?? ''
          continue
        }
        if (ev.kind === 'model' && ev.stage === 'text') {
          live = '' // 完整块到达，丢弃当前流式预览
          liveKey = ''
          if (ev.text) {
            flushTools()
            out.push(
              <div className="model-text md" key={ev.id}>
                <Markdown>{ev.text}</Markdown>
              </div>
            )
          }
          continue
        }
        if (ev.kind === 'model' && ev.stage === 'thinking') {
          flushLive()
          flushTools()
          out.push(<ThinkingBlock key={ev.id} text={ev.thinking ?? ''} />)
          continue
        }
        if (ev.kind === 'hook') continue // hook lifecycle 放右侧 HOOKS，避免主对话流被 started/progress/response 刷屏
        if (ev.kind !== 'tool' && ev.kind !== 'skill' && ev.kind !== 'agent') continue
        flushLive()
        const pendingQuestion = pendingQuestions.find(
          (request) => request.runId === ev.runId && request.questionId === ev.toolUseId
        )
        // 若该 tool_use 催生了 subagent（其 toolUseId 是某些事件的 parentToolUseId），折叠渲染子步骤
        const kids = ev.toolUseId ? childrenByParent.get(ev.toolUseId) : undefined
        const childLiveText = ev.toolUseId && projection.liveParentToolUseId === ev.toolUseId ? projection.liveText : ''
        toolBuf.push({
          ev,
          node: (
            <div key={ev.id}>
              <ToolItem
                ev={ev}
                selected={selectedId === ev.id}
                onSelect={() => onSelect(ev)}
                maxDur={maxDur}
                pendingQuestion={pendingQuestion}
                intervention={ev.toolUseId ? interventionsByQuestionId.get(ev.toolUseId) : undefined}
                queuedQuestionCount={pendingQuestions.length}
                onAnswerQuestion={onAnswerQuestion}
                onOpenFileDiff={openFileDiffFor(ev)}
                turnDone={turn.done}
              />
              {kids?.length || childLiveText ? (
                <SubagentBlock
                  items={kids ?? []}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  pendingQuestions={pendingQuestions}
                  interventions={interventions}
                  onAnswerQuestion={onAnswerQuestion}
                  turnDone={turn.done}
                  liveText={childLiveText}
                  liveKey={projection.liveKey}
                />
              ) : null}
            </div>
          )
        })
      }
    flushLive(!terminal)
    flushTools()
    return out
  }, [
    childrenByParent,
    interventions,
    interventionsByQuestionId,
    visibleItems,
    knownToolUseIds,
    maxDur,
    onAnswerQuestion,
    onSelect,
    openFileDiffFor,
    pendingQuestions,
    projection.liveKey,
    projection.liveParentToolUseId,
    projection.liveText,
    selectedId,
    turn.done,
    terminal
  ])

  return (
    <div className="turn-assistant">
      <div className="who">
        <span className="av">{runtime.avatar}</span> {runtime.label}
        <span className="runid">run · {turn.runId}</span>
        {!turn.done && !turn.error ? (
          <span className="running">
            {backgroundStatus?.waiting ? <Icon name="clock" /> : <span className="spin" />}
            {backgroundStatus?.label ?? '运行中'}
          </span>
        ) : (
          <span className="mini">
            <span className="m cost">
              tok <b>{result ? fmtTok(resultTokenTotal(result)) : '—'}</b>
            </span>
            <span className="m">
              tools <b>{toolN}</b>
            </span>
            {errs > 0 && (
              <span className="m err">
                err <b>{errs}</b>
              </span>
            )}
          </span>
        )}
      </div>
      <div className="turn-flow">
        {turnFlowBody}
        {projection.liveParentToolUseId === null && projection.liveText && (
          <div className={`model-text md${terminal ? '' : ' streaming'}`} key={projection.liveKey || 'live-tail'}>
            <Markdown streaming={!terminal}>{projection.liveText}</Markdown>
          </div>
        )}
      </div>
      {unmatchedPendingQuestions.map((request) => (
        <div className="tool-card k-tool question-pending-fallback" key={`${request.runId}:${request.questionId}`}>
          <div className="tool-row">
            <span className="st pending"><Icon name="clock" /></span>
            <span className="name">AskUserQuestion</span>
            <span className="meta"><span className="question-waiting">等待回答</span></span>
          </div>
          {onAnswerQuestion && (
            <AskUserQuestionInline
              request={request}
              queuedCount={pendingQuestions.length}
              onRespond={onAnswerQuestion}
            />
          )}
        </div>
      ))}
      {interventions
        .filter((intervention) => !knownToolUseIds.has(intervention.request.questionId))
        .map((intervention) => (
          <div className="tool-card k-human intervention-card" key={`intervention:${intervention.request.questionId}`}>
            <div className="tool-row">
              <span className={`st ${intervention.resolution === 'answered' ? 'ok' : 'err'}`}>
                <Icon name={intervention.resolution === 'answered' ? 'check' : 'x'} />
              </span>
              <span className="name">{intervention.kind === 'permission' ? '权限确认' : '人工选择'}</span>
              <span className="arg">{intervention.source}</span>
              <span className="meta"><span className="dur">{(intervention.durationMs / 1000).toFixed(1)}s</span></span>
            </div>
            <AskUserQuestionResult
              request={intervention.request}
              answers={intervention.response.behavior === 'answered' ? intervention.response.answers : undefined}
              resolution={intervention.resolution}
              durationMs={intervention.durationMs}
              source={intervention.source}
            />
          </div>
        ))}
      {turn.done && result?.terminationReason && (
        <TerminationNotice reason={result.terminationReason} />
      )}
      {turn.error && (
        <div className="errline">
          <div className="errmain">
            <Icon name="alert" /> <span>{turn.error}</span>
          </div>
          {turn.errorHint && <div className="errhint">→ {turn.errorHint}</div>}
        </div>
      )}
      {backgroundWork && <BackgroundWorkPanel key={turn.runId} runId={turn.runId} work={backgroundWork} />}
      {!terminal && (
        <div className="skeleton" aria-label="运行中">
          <div className="sk-line" style={{ width: '70%' }} />
          <div className="sk-line" style={{ width: '92%' }} />
          <div className="sk-line" style={{ width: '48%' }} />
        </div>
      )}
      {hookSummary.groups.length > 0 && <HooksSummary summary={hookSummary} />}
      {hasFiles && (
        <FilesSummary
          structured={structured}
          turnDiff={turnDiff}
          preview={turnDiffPreview}
          onOpenDiff={turnDiff && onOpenDiff ? (initialPath) => onOpenDiff(turn, turnDiff, initialPath) : undefined}
        />
      )}
      {turn.done && <TurnFooter items={turn.items} />}
      {canFork && (
        <div className="turn-branch-row">
          <button
            type="button"
            className="turn-branch-btn"
            title="从此轮创建分支会话"
            aria-label="从此轮创建分支会话"
            disabled={forking}
            onClick={() => { void forkAtTurn() }}
          >
            <Icon name="branch" />
            <span>{forking ? '正在创建分支…' : '在新会话中分支'}</span>
          </button>
          {forkError && <span className="turn-branch-error" role="alert">{forkError}</span>}
        </div>
      )}
    </div>
  )
}

// 性能：React.memo —— 流式期间只有「活跃 turn」的 turn 对象变（onTrace 用 map 保留旧 turn 身份），
// 已完成的 turn props 引用不变 → memo 跳过重渲染（含其 ReactMarkdown）。selectedId 变化时才全渲。
export const UserMessage = memo(UserMessageImpl)
export const AssistantTurn = memo(AssistantTurnImpl)
