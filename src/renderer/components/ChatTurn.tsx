// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { memo, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'
import type { HookConfiguredCommand, TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import { isOverviewToolErrorEvent } from '@shared/logical-calls'
import {
  normalizeAgentQuestionRequest,
  type AgentInputAttachment,
  type AgentQuestionRequest,
  type AgentQuestionResponse
} from '@shared/runtime'
import { AskUserQuestionInline, AskUserQuestionResult } from './AskUserQuestionDialog'
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
import type { FileRow, HookSummary, Turn } from '../format'

function runtimeTitleForTurn(turn: Turn): { avatar: string; label: string } {
  const event = turn.items.find((item) => item.providerId || item.runtimeProvider)
  const raw = event?.providerId ?? event?.runtimeProvider?.replace(/_(sdk|cli|server)$/, '') ?? 'agent'
  const label = raw.charAt(0).toUpperCase() + raw.slice(1)
  return { avatar: label.charAt(0), label }
}

// 用户消息：① 斜杠命令 → 气泡内 .slash chip；② skill 注入(claude code 塞的 SKILL.md，非用户输入)
// → 中性折叠注记，不当蓝气泡；③ 普通文本/命令 → 蓝色右对齐气泡 + markdown + 超长折叠。
function attachmentSrc(attachment: AgentInputAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.dataBase64}`
}

function UserMessageImpl({ text, attachments = [] }: { text: string; attachments?: AgentInputAttachment[] }) {
  const [expanded, setExpanded] = useState(false)
  const skillDetailId = useId()
  if (!text && attachments.length === 0) return null
  const { command, body, injectedSkill } = parseUserMessage(text)

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
              <figure className="user-attachment" key={`${attachment.name}:${attachment.size}:${index}`}>
                <img src={attachmentSrc(attachment)} alt={attachment.name} />
                <figcaption>{attachment.name}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {long && (
          <button className="expandbtn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `展开全部（${lines.length} 行）`}
          </button>
        )}
      </div>
    </div>
  )
}

function ThinkingBlock({ text, onSelect }: { text: string; onSelect: () => void }) {
  return (
    <button type="button" className="thinking" onClick={onSelect} title="查看完整思考">
      <div className="head">
        <Icon name="bulb" /> 思考
      </div>
      <div className="preview">{text}</div>
    </button>
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

// 蓝本 .tool-card：状态(check/x) · 工具名 · op(R/W/E) · arg · meta(dur/tok/danger) · chev；点开内联展开 tool-detail。
function ToolItem({
  ev,
  selected,
  onSelect,
  maxDur,
  pendingQuestion,
  queuedQuestionCount = 0,
  onAnswerQuestion,
  turnDone = false
}: {
  ev: TraceEvent
  selected: boolean
  onSelect: () => void
  maxDur: number
  pendingQuestion?: AgentQuestionRequest
  queuedQuestionCount?: number
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  turnDone?: boolean
}) {
  const isAskUserQuestion = ev.tool === 'AskUserQuestion'
  const detailId = useId()
  const [open, setOpen] = useState(isAskUserQuestion)
  const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string>>()
  const meta = toolMeta(ev)
  const op = ev.fileOp === 'read' ? 'r' : ev.fileOp === 'write' ? 'w' : ev.fileOp === 'edit' ? 'e' : null
  const inp = ev.input as Record<string, unknown> | undefined
  const isEdit = ev.tool === 'Edit' && (typeof inp?.old_string === 'string' || typeof inp?.new_string === 'string')
  const questionRequest = useMemo(
    () =>
      pendingQuestion ??
      (isAskUserQuestion && ev.toolUseId
        ? normalizeAgentQuestionRequest(ev.runId, ev.toolUseId, ev.input, ev.agentId)
        : null),
    [ev.agentId, ev.input, ev.runId, ev.toolUseId, isAskUserQuestion, pendingQuestion]
  )
  const waitingForAnswer = !!pendingQuestion
  const waitingForQuestionState =
    !turnDone && isAskUserQuestion && !!questionRequest && !ev.output && !ev.isError && !submittedAnswers
  const missingQuestionResult =
    turnDone && isAskUserQuestion && !!questionRequest && !ev.output && !ev.isError && !submittedAnswers
  const lockedOpen = waitingForAnswer || waitingForQuestionState
  const hasDetail = ev.input != null || !!ev.output || !!questionRequest
  const shownOpen = lockedOpen || open
  const kind = ev.isError ? 'err' : ev.isMcp ? 'mcp' : ev.kind
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
        onClick={() => {
          onSelect()
          if (hasDetail && !lockedOpen) setOpen((v) => !v)
        }}
      >
        <span className={`st ${lockedOpen || missingQuestionResult ? 'pending' : ev.isError ? 'err' : 'ok'}`}>
          <Icon name={lockedOpen ? 'clock' : missingQuestionResult ? 'alert' : ev.isError ? 'x' : 'check'} />
        </span>
        <span className="name">{toolDisplayName(ev)}</span>
        {(kind === 'skill' || kind === 'mcp' || kind === 'agent') && <span className={`kindtag ${kind}`} />}
        {op && <span className={`op ${op}`}>{op.toUpperCase()}</span>}
        <span className="arg">{toolArg(ev)}</span>
        <span className="meta">
          {ev.durationMs != null && <span className="dur">{fmtDur(ev.durationMs)}</span>}
          {durPct > 0 && (
            <span className={`bar ${durPct >= 70 ? 'slow' : ''}`} aria-hidden="true">
              <i style={{ width: `${durPct}%` }} />
            </span>
          )}
          {meta && <span className="tok">{meta}</span>}
          {ev.isMcp && <span className="tok">mcp:{ev.mcpServer}</span>}
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
        ) : isAskUserQuestion && questionRequest && (!!submittedAnswers || !!ev.output || !!ev.isError) ? (
          <AskUserQuestionResult
            request={questionRequest}
            answers={submittedAnswers}
            output={ev.output}
            error={ev.isError}
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
            {ev.output && (
              <>
                <div className="lbl">output{ev.isError ? ' · error' : ''}</div>
                <pre>{ev.output.slice(0, 4000)}</pre>
              </>
            )}
          </div>
        )}
        </div>
      )}
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
  onAnswerQuestion,
  turnDone = false
}: {
  items: TraceEvent[]
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
  pendingQuestions?: AgentQuestionRequest[]
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  turnDone?: boolean
}) {
  const hasPendingQuestion = items.some((event) =>
    pendingQuestions.some((request) => request.runId === event.runId && request.questionId === event.toolUseId)
  )
  const [open, setOpen] = useState(hasPendingQuestion)
  const bodyId = useId()
  useEffect(() => {
    if (hasPendingQuestion) setOpen(true)
  }, [hasPendingQuestion])
  const toolN = items.filter((e) => e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent').length
  const maxDur = Math.max(1, ...items.map((e) => e.durationMs ?? 0))
  return (
    <div className="subagent">
      <button type="button" className="subhead" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((current) => (hasPendingQuestion ? true : !current))}>
        <Icon name="cube" /> 子 agent 内部 · {toolN} 工具 / {items.length} 步{' '}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} className="chev" />
      </button>
      {open && (
        <div id={bodyId} className="subbody">
          {items.map((ev) => {
            if (ev.kind === 'model' && ev.stage === 'thinking') {
              return <ThinkingBlock key={ev.id} text={ev.thinking ?? ''} onSelect={() => onSelect(ev)} />
            }
            if (ev.kind === 'model' && ev.stage === 'text') {
              return ev.text ? (
                <div className="model-text md sub" key={ev.id}>
                  <Markdown>{ev.text}</Markdown>
                </div>
              ) : null
            }
            const pendingQuestion = pendingQuestions.find(
              (request) => request.runId === ev.runId && request.questionId === ev.toolUseId
            )
            return (
              <ToolItem
                key={ev.id}
                ev={ev}
                selected={selectedId === ev.id}
                onSelect={() => onSelect(ev)}
                maxDur={maxDur}
                pendingQuestion={pendingQuestion}
                queuedQuestionCount={pendingQuestions.length}
                onAnswerQuestion={onAnswerQuestion}
                turnDone={turnDone}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function displayDiffPath(path: string, repoRoot?: string): string {
  const normalized = path.replace(/\\/g, '/')
  const root = repoRoot?.replace(/\\/g, '/').replace(/\/$/, '')
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1)
  return basename(path)
}

function FilesSummary({
  structured,
  turnDiff,
  onOpenDiff
}: {
  structured: FileRow[]
  turnDiff?: TurnDiffSnapshot
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
    <details className={diffMode ? 'files-summary diff' : 'files-summary'} open>
      <summary
        onClick={(event) => {
          if (!diffMode || !onOpenDiff) return
          event.preventDefault()
          onOpenDiff()
        }}
        title={diffMode
          ? '本轮开始/结束 Git 工作树快照的净变化；同目录外部并发修改也会计入，ignored 文件不统计'
          : `${structuredScope}${turnDiff ? `；精确行数不可用：${turnDiff.reason ?? turnDiff.status}` : ''}`}
      >
        <Icon name="file" /> {diffMode ? '本轮改动' : '本轮文件（工具证据）'}
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

function HooksSummary({ summary }: { summary: HookSummary }) {
  const detailValue = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  const scopeLabel = (source: HookConfiguredCommand['source']): string =>
    source === 'user' ? '用户' : source === 'project' ? '项目' : source === 'local' ? '本地' : '插件'

  return (
    <details className="turn-hooks-summary" open>
      <summary>
        <Icon name="tool" /> 本轮 Hook
        <span className="hook-total">{summary.logicalRuns} 个处理器实例</span>
      </summary>
      <div className="turn-hooks-body">
        {summary.groups.flatMap((group) =>
          group.scripts.map((script) => {
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
            const configuredCommands = script.command ? [] : (latest?.hookConfiguredCommands ?? [])
            const triggerPrefix = `${group.event}:`
            const triggerSubject = group.trigger.startsWith(triggerPrefix) ? group.trigger.slice(triggerPrefix.length) : group.trigger
            const exactConfiguredMapping =
              !script.command &&
              script.pending === 0 &&
              group.toolCalls > 0 &&
              configuredCommands.length > 0 &&
              group.toolCalls * configuredCommands.length === script.logicalRuns
            const displayedRuns = exactConfiguredMapping ? group.toolCalls : script.logicalRuns
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
              <details className="turn-hook-item" key={script.key}>
                <summary className="turn-hook-row" title={group.trigger}>
                  <span className={`sdot ${tone}`} />
                  <span className="hook-script-name">{script.label}</span>
                  <span className="hook-event-name">{group.event}</span>
                  <span className={`hook-run-status ${tone}`}>{status}</span>
                  <span className="hook-run-count">{displayedRuns}×</span>
                  <Icon name="chevronRight" className="hook-row-chev" />
                </summary>
                <div className="turn-hook-detail">
                  <dl className="hook-detail-grid">
                    {group.toolCalls > 0 && (
                      <>
                        <dt>工具调用</dt>
                        <dd>{group.toolCalls} 次 {triggerSubject}</dd>
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
                        {exactConfiguredMapping ? `每次并行触发的 Hook · ${configuredCommands.length} 个` : `当前配置匹配 · ${configuredCommands.length} 条`}
                      </div>
                      {!exactConfiguredMapping && (
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
          })
        )}
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
  if (!result && tools === 0) return null
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
      {errs > 0 && (
        <>
          <span className="sep" />
          {stat('err', errs, 'err')}
        </>
      )}
    </div>
  )
}

function AssistantTurnImpl({
  turn,
  selectedId,
  onSelect,
  onOpenDiff,
  pendingQuestions = [],
  onAnswerQuestion
}: {
  turn: Turn
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
  onOpenDiff?: (turn: Turn, turnDiff: TurnDiffSnapshot, initialPath?: string) => void
  pendingQuestions?: AgentQuestionRequest[]
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
}) {
  // 把 tool_result 合并进对应 tool_use（加 output），并从流里过滤掉单独的 tool_result 事件
  const items = useMemo(() => {
    const results = new Map<string, TraceEvent>()
    for (const e of turn.items) if (e.stage === 'tool_result' && e.toolUseId) results.set(e.toolUseId, e)
    return turn.items
      .filter((e) => e.stage !== 'tool_result')
      .map((e) => {
        const r = e.toolUseId && (e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent')
          ? results.get(e.toolUseId)
          : undefined
        return r ? { ...e, output: r.text, isError: r.isError ?? e.isError, durationMs: r.durationMs ?? e.durationMs } : e
      })
  }, [turn.items])
  const result = resultOf({ items })
  const turnDiff = [...items].reverse().find((e) => e.kind === 'harness' && e.stage === 'turn_diff')?.turnDiff
  const { structured } = useMemo(() => aggregateFiles(items), [items])
  const hookSummary = useMemo(() => aggregateHooks(items), [items])
  const hasFiles =
    structured.length > 0 ||
    (turnDiff?.status === 'captured' && turnDiff.files.length > 0) ||
    turnDiff?.status === 'timeout' ||
    turnDiff?.status === 'failed'
  const toolItems = items.filter((e) => e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent')
  const maxDur = Math.max(1, ...toolItems.map((e) => e.durationMs ?? 0))
  const toolN = useMemo(
    () => aggregateCalls(logicalCallEventsForTurn(items)).totalCalls,
    [items]
  )
  const errs = turn.items.filter(isOverviewToolErrorEvent).length
  const runtime = runtimeTitleForTurn(turn)
  // P1：subagent 内部步骤（parentToolUseId 指向父 Task tool_use）按父分组，折叠进父 Task 卡
  const childrenByParent = useMemo(() => {
    const m = new Map<string, TraceEvent[]>()
    for (const ev of items) {
      if (ev.parentToolUseId) {
        const arr = m.get(ev.parentToolUseId) ?? []
        arr.push(ev)
        m.set(ev.parentToolUseId, arr)
      }
    }
    return m
  }, [items])
  const topLevelToolUseIds = new Set(
    items
      .filter(
        (event) =>
          !event.parentToolUseId &&
          (event.kind === 'tool' || event.kind === 'skill' || event.kind === 'agent') &&
          !!event.toolUseId
      )
      .map((event) => event.toolUseId as string)
  )
  const renderedPendingQuestionKeys = new Set(
    items
      .filter((event) => !event.parentToolUseId || topLevelToolUseIds.has(event.parentToolUseId))
      .filter((event) =>
        pendingQuestions.some(
          (request) => request.runId === event.runId && request.questionId === event.toolUseId
        )
      )
      .map((event) => `${event.runId}\0${event.toolUseId}`)
  )
  const unmatchedPendingQuestions = pendingQuestions.filter(
    (request) =>
      (request.runId === turn.runId || items.some((event) => event.runId === request.runId)) &&
      !renderedPendingQuestionKeys.has(`${request.runId}\0${request.questionId}`)
  )
  return (
    <div className="turn-assistant">
      <div className="who">
        <span className="av">{runtime.avatar}</span> {runtime.label}
        <span className="runid">run · {turn.runId}</span>
        {!turn.done && !turn.error ? (
          <span className="running">
            <span className="spin" />
            运行中
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
      {hasFiles && (
        <FilesSummary
          structured={structured}
          turnDiff={turnDiff}
          onOpenDiff={turnDiff && onOpenDiff ? (initialPath) => onOpenDiff(turn, turnDiff, initialPath) : undefined}
        />
      )}
      {hookSummary.groups.length > 0 && <HooksSummary summary={hookSummary} />}
      {(() => {
        // C1：合并连续 text_delta；旧版 Codex 曾把每个流式增量误标成 text，这里兼容已在途的旧事件。
        // 遇到可见事件就落成独立段，保留模型说明与工具调用的真实顺序。
        // 完整 text 块只替换当前尚未落盘的流式片段，避免整轮进度被拼成一个超长段落。
        const out: ReactNode[] = []
        let live = ''
        let liveKey = ''
        const flushLive = (streaming = false): void => {
          if (!live) return
          out.push(
            <div className={`model-text md${streaming ? ' streaming' : ''}`} key={liveKey || `live-${out.length}`}>
              <Markdown>{live}</Markdown>
            </div>
          )
          live = ''
          liveKey = ''
        }
        for (const ev of items) {
          if (ev.kind === 'harness') continue
          if (ev.parentToolUseId) continue // subagent 子步骤：在父 Task 卡下折叠渲染，不在主流平铺
          const isStreamFragment =
            ev.kind === 'model' &&
            (ev.stage === 'text_delta' ||
              (ev.stage === 'text' && (ev.providerId === 'codex' || ev.runtimeProvider === 'codex_cli')))
          if (isStreamFragment) {
            if (!live) liveKey = ev.id
            live += ev.text ?? ''
            continue
          }
          if (ev.kind === 'model' && ev.stage === 'text') {
            live = '' // 完整块到达，丢弃当前流式预览
            liveKey = ''
            if (ev.text)
              out.push(
                <div className="model-text md" key={ev.id}>
                  <Markdown>{ev.text}</Markdown>
                </div>
              )
            continue
          }
          if (ev.kind === 'model' && ev.stage === 'thinking') {
            flushLive()
            out.push(<ThinkingBlock key={ev.id} text={ev.thinking ?? ''} onSelect={() => onSelect(ev)} />)
            continue
          }
          if (ev.kind === 'hook') continue // hook lifecycle 放右侧 HOOKS，避免主对话流被 started/progress/response 刷屏
          if (ev.kind !== 'tool' && ev.kind !== 'skill' && ev.kind !== 'agent') continue
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
              queuedQuestionCount={pendingQuestions.length}
              onAnswerQuestion={onAnswerQuestion}
              turnDone={turn.done}
            />
          )
          // 若该 tool_use 催生了 subagent（其 toolUseId 是某些事件的 parentToolUseId），折叠渲染子步骤
          const kids = ev.toolUseId ? childrenByParent.get(ev.toolUseId) : undefined
          if (kids?.length) {
            out.push(
              <SubagentBlock
                key={`${ev.id}-sub`}
                items={kids}
                selectedId={selectedId}
                onSelect={onSelect}
                pendingQuestions={pendingQuestions}
                onAnswerQuestion={onAnswerQuestion}
                turnDone={turn.done}
              />
            )
          }
        }
        flushLive(!turn.done)
        return out
      })()}
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
      {turn.error && (
        <div className="errline">
          <div className="errmain">
            <Icon name="alert" /> <span>{turn.error}</span>
          </div>
          {turn.errorHint && <div className="errhint">→ {turn.errorHint}</div>}
        </div>
      )}
      {!turn.done && !turn.error && (
        <div className="skeleton" aria-label="运行中">
          <div className="sk-line" style={{ width: '70%' }} />
          <div className="sk-line" style={{ width: '92%' }} />
          <div className="sk-line" style={{ width: '48%' }} />
        </div>
      )}
      {turn.done && <TurnFooter items={turn.items} />}
    </div>
  )
}

// 性能：React.memo —— 流式期间只有「活跃 turn」的 turn 对象变（onTrace 用 map 保留旧 turn 身份），
// 已完成的 turn props 引用不变 → memo 跳过重渲染（含其 ReactMarkdown）。selectedId 变化时才全渲。
export const UserMessage = memo(UserMessageImpl)
export const AssistantTurn = memo(AssistantTurnImpl)
