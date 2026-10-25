// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'





import { Disclosure } from './Disclosure'

import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'
import type { TraceEvent, TurnDiffSnapshot } from '@shared/trace'


import { type AgentIntervention, type AgentQuestionRequest, type AgentQuestionResponse } from '@shared/runtime'



import { aggregateCalls, basename, fileBadge, logicalCallEventsForTurn, toolArg, toolDisplayName } from '../format'
import type { FileRow } from '../format'
import { displayDiffPath } from '../turn-diff'




import { coalesceAdjacentThinking, fmtDur, ThinkingBlock } from './ChatTurnShared'

import { ToolItem } from './ChatTurnToolItem'
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

export function ToolGroup({
  events,
  forceOpen = false,
  attention = false,
  reveal = false,
  children
}: {
  events: TraceEvent[]
  forceOpen?: boolean
  attention?: boolean
  reveal?: boolean
  children: ReactNode
}) {
  const bodyId = useId()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (reveal) setOpen(true)
  }, [reveal])
  const shownOpen = forceOpen || reveal || open
  const { names, dur, failed, count } = toolGroupSummary(events)
  const single = count === 1 ? events[0] : null
  const label = single ? `${toolDisplayName(single)}  ${toolArg(single)}`.trim() : names.join(' · ')
  if (attention && single?.tool === 'AskUserQuestion') {
    return <div className="tool-group open question-tool-group"><div className="tool-group-body">{children}</div></div>
  }
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
        <Icon name="chevronRight" className={`chev motion-chevron ${shownOpen ? 'is-open' : ''}`} />
      </button>
      <Disclosure open={shownOpen}>{() => <div id={bodyId} className="tool-group-body">{children}</div>}</Disclosure>
    </div>
  )
}

// P1（RFC §8.1 NIT-2）：subagent 的内部步骤（text/thinking/工具，parentToolUseId=父 Task tool_use_id）
// 默认折叠进父 Task 卡，避免多 subagent 会话主时间线被碎碎念淹没（forwardSubagentText 的本意是嵌套面板）。
export function SubagentBlock({
  items,
  selectedId,
  onSelect,
  pendingQuestions = [],
  interventions = [],
  onAnswerQuestion,
  turnDone = false,
  liveText = '',
  liveThinking = '',
  liveKey: liveTailKey = '',
  remote = false,
  liveArrivalKeys = new Set<string>()
}: {
  items: TraceEvent[]
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
  pendingQuestions?: AgentQuestionRequest[]
  interventions?: AgentIntervention[]
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  turnDone?: boolean
  liveText?: string
  liveThinking?: string
  liveKey?: string
  remote?: boolean
  liveArrivalKeys?: ReadonlySet<string>
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
        <Icon name="chevronRight" className={`chev motion-chevron ${open ? 'is-open' : ''}`} />
      </button>
      <Disclosure open={open} immediate={hasPendingQuestion}>{() => (
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
                  liveArrival={liveArrivalKeys.has(ev.id)}
                  pendingQuestion={pendingQuestion}
                  intervention={interventions.find((item) => item.request.questionId === ev.toolUseId)}
                  queuedQuestionCount={pendingQuestions.length}
                  onAnswerQuestion={onAnswerQuestion}
                  turnDone={turnDone}
                  remote={remote}
                />
              )
            }
            flushLive()
            if (liveThinking) {
              out.push(
                <ThinkingBlock
                  key={liveTailKey || 'subagent-live-thinking-tail'}
                  text={liveThinking}
                  streaming={!turnDone}
                />
              )
            } else if (liveText) {
              out.push(
                <div className="model-text md sub streaming" key={liveTailKey || 'subagent-live-tail'}>
                  <Markdown streaming={!turnDone}>{liveText}</Markdown>
                </div>
              )
            }
            return out
          })()}
        </div>
      )}</Disclosure>
    </div>
  )
}

export function FilesSummary({
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
