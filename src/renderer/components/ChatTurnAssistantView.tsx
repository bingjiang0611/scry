import type { ReactNode } from 'react'
import { piRuntimeCopy } from '@shared/constants/copy'
import { type BackgroundWork } from '@shared/background-work'
import { classifyRunTermination, type AgentQuestionRequest, type AgentQuestionResponse } from '@shared/runtime'
import type { TraceEvent, TurnDiffSnapshot } from '@shared/trace'
import type { TurnStreamProjection } from '../turn-stream-projection'
import type { FileRow, HookSummary, Turn } from '../format'
import { BackgroundWorkPanel } from './BackgroundWorkPanel'
import { AskUserQuestionInline, AskUserQuestionResult } from './AskUserQuestionDialog'
import { WorkspaceFileLinkProvider } from './MarkdownImpl'
import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'
import { FilesSummary } from './ChatTurnTools'
import { HooksSummary } from './ChatTurnHooks'
import { ThinkingBlock } from './ChatTurnShared'
import { TurnFooter, TerminationNotice, ToolTerminationNotice } from './ChatTurnFooter'
import { ANTIGRAVITY_COPY } from '../constants/antigravity-copy'
import { resultTokenTotal, fmtTok } from '../format'
import type { TurnHookPhase } from './ChatTurnHookData'
import { Button } from './primitives/Button'

export function AssistantTurnView({
  turn, runtime, finalizing, backgroundStatus, result, toolN, errs, linkWorkspaces, linkFilePaths, turnFlowBody,
  projection, terminal, unmatchedPendingQuestions, onAnswerQuestion, pendingQuestions, interventions, knownToolUseIds,
  hookSummary, hookPhases, liveArrivalKeys, hasFiles, structured, turnDiff, turnDiffPreview, onOpenDiff, footerArrival,
  canFork, forkTitle, forkLabel, forking, forkAtTurn, forkError, remote, backgroundWork
}: {
  turn: Turn
  runtime: { avatar: string; label: string }
  finalizing: boolean
  backgroundStatus?: { waiting?: boolean; label?: string }
  result?: TraceEvent
  toolN: number
  errs: number
  linkWorkspaces: string[]
  linkFilePaths: string[]
  turnFlowBody: ReactNode
  projection: TurnStreamProjection
  terminal: boolean
  unmatchedPendingQuestions: AgentQuestionRequest[]
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  pendingQuestions: AgentQuestionRequest[]
  interventions: NonNullable<TraceEvent['intervention']>[]
  knownToolUseIds: ReadonlySet<string>
  hookSummary: HookSummary
  hookPhases: TurnHookPhase[]
  liveArrivalKeys: ReadonlySet<string>
  hasFiles: boolean
  structured: FileRow[]
  turnDiff?: TurnDiffSnapshot
  turnDiffPreview: boolean
  onOpenDiff?: (turn: Turn, turnDiff: TurnDiffSnapshot, initialPath?: string) => void
  footerArrival: boolean
  canFork: boolean
  forkTitle: string
  forkLabel: string
  forking: boolean
  forkAtTurn: () => void
  forkError: string | null
  remote: boolean
  backgroundWork?: BackgroundWork
}) {
  // Old archives retain their original generic retry hint; correct the display without
  // rewriting evidence or suggesting that the account binding itself has changed.
  const errorHint = turn.error?.includes('account_changed_start_new_session')
    && classifyRunTermination({ message: turn.error }) !== 'input_context_overflow'
    ? piRuntimeCopy.qoderAccountChangedHint(turn.errorHint)
    : turn.errorHint
  const resultMeta = result?.runtimeMetadata as Record<string, unknown> | undefined
  const usageCoverage = resultMeta?.usageCoverage === 'partial' || resultMeta?.usageCoverage === 'unavailable'
    ? resultMeta.usageCoverage
    : undefined
  const usageCoverageReason = typeof resultMeta?.usageCoverageReason === 'string' ? resultMeta.usageCoverageReason : undefined
  return (
    <div className="turn-assistant">
      <div className="who">
        <span className="av">{runtime.avatar}</span> {runtime.label}
        <span className="runid">{turn.pendingStart ? '正在发送' : `run · ${turn.runId}`}</span>
        {!turn.done && !turn.error ? (
          <span className="running">
            {finalizing || backgroundStatus?.waiting ? <Icon name="clock" /> : <span className="spin" />}
            {turn.pendingStart ? '正在启动' : finalizing ? '记录收口中' : backgroundStatus?.label ?? '运行中'}
          </span>
        ) : (
          <span className="mini">
            <span className="m cost" title={usageCoverageReason}>
              tok <b>{usageCoverage === 'unavailable' ? '—' : result ? fmtTok(resultTokenTotal(result)) : '—'}</b>
              {usageCoverage === 'partial' ? ` · ${ANTIGRAVITY_COPY.usagePartial}` : ''}
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
      <WorkspaceFileLinkProvider workspaces={linkWorkspaces} filePaths={linkFilePaths}>
        <div className="turn-flow">
          {turnFlowBody}
          {projection.liveParentToolUseId === null && projection.liveThinking && (
            <ThinkingBlock
              key={projection.liveKey || 'live-thinking-tail'}
              text={projection.liveThinking}
              streaming={!terminal}
            />
          )}
          {projection.liveParentToolUseId === null && projection.liveText && (
            <div className={`model-text md${terminal ? '' : ' streaming'}`} key={projection.liveKey || 'live-tail'}>
              <Markdown streaming={!terminal}>{projection.liveText}</Markdown>
            </div>
          )}
        </div>
      </WorkspaceFileLinkProvider>
      {unmatchedPendingQuestions.map((request) => (
        <div className="tool-card k-tool question-pending-fallback" key={`${request.runId}:${request.questionId}`}>
          <div className="tool-row">
            <span className="st pending"><Icon name="message" /></span>
            <span className="name">需要你的选择</span>
            <span className="meta"><span className="question-count">{request.questions.length} 个问题</span></span>
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
        // 会话结尾只保留权限确认这类信任边界证据；人工选择（clarification）不再在聊天流末尾堆卡片，
        // 其原始记录仍保留在 .scry records 与纵览面板中。
        .filter((intervention) => !knownToolUseIds.has(intervention.request.questionId) && intervention.kind === 'permission')
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
      {turn.done && result?.toolTermination && (
        <ToolTerminationNotice evidence={result.toolTermination} />
      )}
      {turn.done && result?.terminationReason && (
        <TerminationNotice reason={result.terminationReason} />
      )}
      {turn.error && (
        <div className="errline">
          <div className="errmain">
            <Icon name="alert" /> <span>{turn.error}</span>
          </div>
          {errorHint && <div className="errhint">→ {errorHint}</div>}
        </div>
      )}
      {/* History/attachment evidence can be partial without a Provider failure. */}
      {!turn.error && turn.errorHint && <div className="errhint" role="note">{turn.errorHint}</div>}
      {backgroundWork && <BackgroundWorkPanel key={turn.runId} runId={turn.runId} work={remote ? { ...backgroundWork, taskStop: 'unavailable' } : backgroundWork} />}
      {/* A placeholder for the answer only until its first output. After that the
          header's 运行中, the composer's elapsed time and the streaming caret already
          say it is working; a second indicator under the text would repeat them and,
          when it left at the end, pull the turn up. The header carries the status for
          screen readers, so these shapes are hidden from them. */}
      {!terminal && !hasVisibleOutput(projection) && (
        <div className="skeleton" aria-hidden="true">
          <div className="sk-line" style={{ width: '70%' }} />
          <div className="sk-line" style={{ width: '92%' }} />
          <div className="sk-line" style={{ width: '48%' }} />
        </div>
      )}
      {hookSummary.groups.length > 0 && <HooksSummary summary={hookSummary} phases={hookPhases} liveArrivalKeys={liveArrivalKeys} />}
      {hasFiles && (
        <FilesSummary
          structured={structured}
          turnDiff={turnDiff}
          preview={turnDiffPreview}
          onOpenDiff={turnDiff && onOpenDiff ? (initialPath) => onOpenDiff(turn, turnDiff, initialPath) : undefined}
        />
      )}
      {(turn.done || canFork) && (
        <div className={`turn-tail${footerArrival ? ' stream-arrival' : ''}`}>
          {turn.done && <TurnFooter items={turn.items} files={structured} />}
          {canFork && (
            <div className="turn-branch-row">
              <Button variant="quiet" size="sm" className="turn-branch-btn"
                title={forkTitle}
                aria-label={forkTitle}
                disabled={forking}
                onClick={() => { void forkAtTurn() }}
              >
                <Icon name="branch" />
                <span>{forking ? '正在创建分支…' : forkLabel}</span>
              </Button>
              {forkError && <span className="turn-branch-error" role="alert">{forkError}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const VISIBLE_KINDS: ReadonlySet<TraceEvent['kind']> = new Set(['tool', 'skill', 'agent', 'model', 'hook'])

/** Whether the turn has shown anything of the answer yet: text, thinking or a call. */
export function hasVisibleOutput(projection: TurnStreamProjection): boolean {
  return projection.liveText.length > 0 || projection.liveThinking.length > 0
    || projection.structuralItems.some((event) => VISIBLE_KINDS.has(event.kind))
}
