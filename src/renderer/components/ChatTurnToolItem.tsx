// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { useId, useMemo, useState } from 'react'





import { Disclosure } from './Disclosure'


import { Icon } from './primitives/Icon'
import type { TraceEvent } from '@shared/trace'


import { normalizeAgentQuestionRequest, type AgentIntervention, type AgentQuestionRequest, type AgentQuestionResponse } from '@shared/runtime'
import { AskUserQuestionInline, AskUserQuestionResult } from './AskUserQuestionDialog'


import { toolArg, toolDisplayName, toolMeta } from '../format'

import { editActionLineCounts } from '../turn-diff'



import { RecorderContentPager } from './ChatTurnPager'
import { fmtDur } from './ChatTurnShared'
export function ToolItem({
  ev,
  selected,
  onSelect,
  maxDur,
  pendingQuestion,
  intervention,
  queuedQuestionCount = 0,
  onAnswerQuestion,
  onOpenFileDiff,
  turnDone = false,
  remote = false,
  liveArrival = false
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
  remote?: boolean
  liveArrival?: boolean
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
  const inputText = useMemo(() => ev.input != null ? JSON.stringify(ev.input, null, 2) : null, [ev.input])
  const detailLong = useMemo(() => (ev.output?.split('\n', 41).length ?? 0) > 40 || (inputText?.split('\n', 41).length ?? 0) > 40, [ev.output, inputText])
  const kind = ev.isError ? 'err' : ev.isMcp ? 'mcp' : ev.kind
  const displayName = toolDisplayName(ev)
  const rowDisplayName = waitingForAnswer ? '需要你的选择' : displayName
  const durPct = ev.durationMs != null ? Math.max(3, Math.round((ev.durationMs / maxDur) * 100)) : 0
  return (
    <div
      className={`tool-card k-${kind} ${selected ? 'selected' : ''} ${ev.agentId || ev.parentToolUseId ? 'sub' : ''}${liveArrival ? ' stream-arrival' : ''}`}
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
          <Icon name={waitingForAnswer ? 'message' : lockedOpen ? 'clock' : missingQuestionResult ? 'alert' : ev.isError || interventionFailed ? 'x' : 'check'} />
        </span>
        <span className="name" title={rowDisplayName}>{rowDisplayName}</span>
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
          {waitingForAnswer && questionRequest && (
            <span className="question-count">{questionRequest.questions.length} 个问题</span>
          )}
          {!waitingForAnswer && waitingForQuestionState && <span className="question-waiting">等待状态同步</span>}
          {missingQuestionResult && <span className="question-waiting">未获得返回</span>}
          {ev.danger && (
            <span className={ev.danger.level === 'danger' ? 'danger' : 'warn'} title={ev.danger.reason}>
              <span className={`sdot ${ev.danger.level === 'danger' ? 'bad' : 'warn'}`} />
            </span>
          )}
        </span>
        {hasDetail && !lockedOpen && <Icon name="chevronRight" className={`chev motion-chevron ${shownOpen ? 'is-open' : ''}`} />}
      </button>
      {hasDetail && <Disclosure open={shownOpen} long={detailLong} immediate={lockedOpen}>{() => (
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
                <pre>{inputText}</pre>
              </>
            ) : null}
            {ev.inputContent?.contentRef && <RecorderContentPager label="input" contentRef={ev.inputContent.contentRef} source={ev.inputContent.source} remote={remote} />}
            {ev.output && (
              <>
                <div className="lbl">output{ev.isError ? ' · error' : ''}{ev.outputContent?.storage === 'truncated' ? ' · preview' : ''}</div>
                <pre>{ev.output.slice(0, 4000)}</pre>
              </>
            )}
            {ev.outputContent?.contentRef && <RecorderContentPager label="output" contentRef={ev.outputContent.contentRef} source={ev.outputContent.source} remote={remote} />}
          </div>
        )}
        </div>
      )}</Disclosure>}
    </div>
  )
}

// 方案 C：一段连续的工具调用退成脚注——收起时只显示计数徽章 + 工具名列表 + 耗时，
// 点开抽屉展示原有 tool-card 明细。有待回答的 AskUserQuestion 时强制展开，避免藏住输入。
