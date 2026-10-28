// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'

import { latestBackgroundWork } from '@shared/background-work'
import { backgroundWorkStatus } from '../background-work-status'
import { useCompletedTurnFlow } from '../completed-turn-flow'
import { TURN_FLOW_COPY } from '../constants/copy'
import { providerHasEnded } from '../run-stop-status'


import { useLiveArrivalKeys } from '../hooks/useLiveArrivalKeys'
import Markdown from './MarkdownImpl'

import type { TraceEvent, TurnDiffSnapshot } from '@shared/trace'

import { isOverviewToolErrorEvent } from '@shared/logical-calls'
import { type AgentQuestionRequest, type AgentQuestionResponse } from '@shared/runtime'



import { aggregateCalls, aggregateHooks, aggregateFiles, logicalCallEventsForTurn, resultOf } from '../format'
import type { Turn } from '../format'
import { turnDiffViewOf } from '../turn-diff'
import { TurnStreamProjectionCache, isStreamTextFragment } from '../turn-stream-projection'
import { SteerEvidenceMessage } from './ChatTurnUser'


import { runtimeTitleForTurn, coalesceAdjacentThinking, ThinkingBlock } from './ChatTurnShared'
import { ToolGroup, SubagentBlock } from './ChatTurnTools'
import { ToolItem } from './ChatTurnToolItem'
import { aggregateTurnHookPhases } from './ChatTurnHookData'

import { AssistantTurnView } from './ChatTurnAssistantView'

function AssistantTurnImpl({
  turn,
  selectedId,
  onSelect,
  onOpenDiff,
  onForkTurn,
  pendingQuestions = [],
  onAnswerQuestion,
  remote = false,
  liveArrivalEligible = false,
  footerArrivalEligible = false,
  liveArrivalResetKey
}: {
  turn: Turn
  selectedId: string | null
  onSelect: (ev: TraceEvent) => void
  onOpenDiff?: (turn: Turn, turnDiff: TurnDiffSnapshot, initialPath?: string) => void
  onForkTurn?: (turn: Turn) => Promise<void>
  pendingQuestions?: AgentQuestionRequest[]
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  remote?: boolean
  liveArrivalEligible?: boolean
  footerArrivalEligible?: boolean
  liveArrivalResetKey?: unknown
}) {
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  const [flowExpanded, setFlowExpanded] = useState(false)
  // 长轮次流式期把「还在增长的尾部文本」与结构化事件分开：只有结构真的变了才重算
  // 下面这些 O(全部事件) 的投影，纯 token 增量只更新一个字符串。
  const projectionCache = useRef<TurnStreamProjectionCache>()
  if (!projectionCache.current) projectionCache.current = new TurnStreamProjectionCache()
  const finalizing = !turn.done && !turn.error && providerHasEnded(turn.items)
  const backgroundWork = !turn.done && !turn.error && !finalizing ? latestBackgroundWork(turn.items) : undefined
  const backgroundStatus = backgroundWorkStatus(backgroundWork)
  const terminal = turn.done || !!turn.error || finalizing || backgroundStatus?.waiting === true
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
  const { items: flowItems, hiddenCount: hiddenFlowItemCount } = useCompletedTurnFlow(visibleItems, {
    completed: turn.done || Boolean(turn.error),
    expanded: flowExpanded,
    selectedId
  })
  const hookSummary = useMemo(() => aggregateHooks(items), [items])
  const hookPhases = useMemo(() => aggregateTurnHookPhases(hookSummary), [hookSummary])
  const liveStructuralKeys = useMemo(() => {
    const toolKeys = visibleItems
      .filter(event => event.kind === 'tool' || event.kind === 'skill' || event.kind === 'agent')
      .map(event => event.id)
    const hookKeys = hookPhases.flatMap(phase => [
      `hook:${phase.event}`,
      ...phase.scripts.map(script => `hook:${phase.event}:${script.key}`)
    ])
    return [...toolKeys, ...hookKeys]
  }, [hookPhases, visibleItems])
  const liveArrivalKeys = useLiveArrivalKeys(liveStructuralKeys, liveArrivalEligible, liveArrivalResetKey)
  const latestSteerEvents = useMemo(() => {
    const latest = new Map<string, TraceEvent>()
    for (const event of visibleItems) if (event.steer) latest.set(event.steer.messageId, event)
    return latest
  }, [visibleItems])
  const result = resultOf({ items })
  const footerKnown = turn.done && result != null && [result.tokensIn, result.tokensOut, result.durationMs, result.durationApiMs].some(value => value != null)
  const footerKeys = useMemo(() => footerKnown ? ['footer'] : [], [footerKnown])
  const footerArrival = useLiveArrivalKeys(footerKeys, footerArrivalEligible, liveArrivalResetKey).has('footer')
  // Failed provider turns can still have an authoritative native boundary. Exposing that
  // boundary lets Pi/Rotom recover exactly as its terminal tree navigation does, instead
  // of trapping the user on a repeatedly failing session leaf.
  const canFork = Boolean(
    onForkTurn && turn.done && turn.providerTurnId && (turn.forkTurnId ?? turn.providerTurnId)
  )
  const forkLabel = turn.error ? '从失败处恢复' : '在新会话中分支'
  const forkTitle = turn.error ? '从失败轮次创建恢复分支' : '从此轮创建分支会话'
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
  const turnRef = useRef(turn)
  turnRef.current = turn
  // 轮次跑完且该文件真的出现在本轮 Git 快照里，才把工具卡接到同一个 Diff 面板；
  // 运行中或该文件没有净改动时不给假入口。用 ref 读取最新 turn，避免每个 token 都重建工具树回调。
  const openFileDiffFor = useCallback((event: TraceEvent): (() => void) | undefined => {
    if (!onOpenDiff || !turnDiff || !turn.done) return undefined
    const path = event.filePath
    if (!path || !diffPaths.has(path)) return undefined
    return () => onOpenDiff(turnRef.current, turnDiff, path)
  }, [diffPaths, onOpenDiff, turn.done, turnDiff])
  const { structured } = useMemo(() => aggregateFiles(items), [items])
  // A short filename belongs to this turn's footprint/diff, not to a later turn
  // or the currently selected project. Main still canonicalizes every opened target.
  const linkWorkspaces = useMemo(() => turn.cwd ? [turn.cwd] : [], [turn.cwd])
  const linkFilePaths = useMemo(() => [...new Set([...structured.map((file) => file.path), ...diffPaths])], [structured, diffPaths])
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
  const nestedLiveText = projection.liveParentToolUseId === null ? '' : projection.liveText
  const nestedLiveThinking = projection.liveParentToolUseId === null ? '' : projection.liveThinking
  const nestedLiveKey = projection.liveParentToolUseId === null ? '' : projection.liveKey
  // C1：合并连续 text_delta；旧版 Codex 曾把每个流式增量误标成 text，这里兼容已在途的旧事件。
  // 遇到可见事件就落成独立段，保留模型说明与工具调用的真实顺序。
  // 完整 text 块只替换当前尚未落盘的流式片段，避免整轮进度被拼成一个超长段落。
  // 尾部还在增长的顶层流式文本不进这里：它单独渲染，所以纯 token 增量不会重建整条时间线。
  const turnFlowBody = useMemo(() => {
      const out: ReactNode[] = []
      if (hiddenFlowItemCount > 0) {
        out.push(
          <button
            type="button"
            className="turn-flow-reveal"
            key="earlier-turn-flow"
            onClick={() => setFlowExpanded(true)}
            aria-label={TURN_FLOW_COPY.showEarlierLabel(hiddenFlowItemCount)}
          >
            {TURN_FLOW_COPY.showEarlier(hiddenFlowItemCount)}
          </button>
        )
      }
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
          (!turn.done && ev.tool === 'AskUserQuestion') ||
          pendingQuestions.some((request) => request.runId === ev.runId && request.questionId === ev.toolUseId)
        )
        out.push(
          <ToolGroup
            key={`tg-${buf[0].ev.id}`}
            events={buf.map((b) => b.ev)}
            forceOpen={forceOpen}
            attention={buf.some(({ ev }) =>
              pendingQuestions.some((request) => request.runId === ev.runId && request.questionId === ev.toolUseId)
            )}
            reveal={buf.some(({ ev }) =>
              ev.id === selectedId ||
              (ev.toolUseId ? childrenByParent.get(ev.toolUseId)?.some((child) => child.id === selectedId) : false)
            )}
          >
            {buf.map((b) => b.node)}
          </ToolGroup>
        )
      }
      for (const ev of flowItems) {
        if (ev.kind === 'human' && ev.stage === 'steer' && ev.steer) {
          if (latestSteerEvents.get(ev.steer.messageId)?.id === ev.id) {
            flushLive()
            flushTools()
            out.push(<SteerEvidenceMessage key={ev.id} evidence={ev.steer} />)
          }
          continue
        }
        if (ev.kind === 'harness') {
          if (ev.providerId === 'pi' && ev.runtimeProvider === 'pi_rpc' && ev.text &&
            (ev.providerCommand || ev.stage === 'runtime:extension_message' ||
              ev.stage === 'runtime:extension_ui' && ev.runtimeMetadata?.method === 'notify' && ev.runtimeMetadata.notifyType !== 'info')) {
            const label = ev.providerCommand ? 'Pi 命令'
              : ev.stage === 'runtime:extension_message' ? 'Pi 扩展消息' : 'Pi 扩展通知'
            flushLive()
            flushTools()
            out.push(
              <div className="tool-card k-human" role="note" aria-label={ev.providerCommand ? 'Pi 命令反馈' : label} key={ev.id}>
                <div className="tool-detail"><div className="lbl">{label}{ev.isError ? ' · 错误' : ''}</div><pre>{ev.text}</pre></div>
              </div>
            )
          }
          continue
        }
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
        const childHasLiveTail = ev.toolUseId && projection.liveParentToolUseId === ev.toolUseId
        const childLiveText = childHasLiveTail ? nestedLiveText : ''
        const childLiveThinking = childHasLiveTail ? nestedLiveThinking : ''
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
                remote={remote}
                liveArrival={liveArrivalKeys.has(ev.id)}
              />
              {kids?.length || childLiveText || childLiveThinking ? (
                <SubagentBlock
                  items={kids ?? []}
                  liveArrivalKeys={liveArrivalKeys}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  pendingQuestions={pendingQuestions}
                  interventions={interventions}
                  onAnswerQuestion={onAnswerQuestion}
                  turnDone={turn.done}
                  liveText={childLiveText}
                  liveThinking={childLiveThinking}
                  liveKey={nestedLiveKey}
                  remote={remote}
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
    flowItems,
    hiddenFlowItemCount,
    knownToolUseIds,
    maxDur,
    onAnswerQuestion,
    onSelect,
    openFileDiffFor,
    pendingQuestions,
    nestedLiveKey,
    nestedLiveText,
    nestedLiveThinking,
    latestSteerEvents,
    remote,
    projection.liveParentToolUseId,
    selectedId,
    turn.done,
    terminal
  ])

  return <AssistantTurnView
    turn={turn} runtime={runtime} finalizing={finalizing} backgroundStatus={backgroundStatus} result={result}
    toolN={toolN} errs={errs} linkWorkspaces={linkWorkspaces} linkFilePaths={linkFilePaths} turnFlowBody={turnFlowBody}
    projection={projection} terminal={terminal} unmatchedPendingQuestions={unmatchedPendingQuestions}
    onAnswerQuestion={onAnswerQuestion} pendingQuestions={pendingQuestions} interventions={interventions}
    knownToolUseIds={knownToolUseIds} hookSummary={hookSummary} hookPhases={hookPhases}
    liveArrivalKeys={liveArrivalKeys} hasFiles={hasFiles} structured={structured} turnDiff={turnDiff}
    turnDiffPreview={turnDiffPreview} onOpenDiff={onOpenDiff} footerArrival={footerArrival}
    canFork={canFork} forkTitle={forkTitle} forkLabel={forkLabel} forking={forking} forkAtTurn={forkAtTurn} forkError={forkError}
    remote={remote} backgroundWork={backgroundWork}
  />
}

export const AssistantTurn = memo(AssistantTurnImpl)
