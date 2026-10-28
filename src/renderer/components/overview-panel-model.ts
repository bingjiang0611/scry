// 总览面板的证据推导：只做投影与聚合，不接触 DOM、IPC 或持久化。
import { useMemo } from 'react'
import { contextCompactionOf, contextUsageEvidence, mcpCallsForEvent, type TraceEvent, type WorkspaceDiffResult } from '@shared/trace'
import type { RuntimeProvider } from '@shared/runtime'
import { latestBackgroundWork } from '@shared/background-work'
import { backgroundWorkStatus } from '../background-work-status'
import { isInferredSkillLoad } from '../skill-load-evidence'
import { buildTurnTimingBreakdown } from '../turn-timing'
import { overviewToolErrors } from './OverviewToolErrors'
import { aggregateCalls, aggregateFiles, aggregateHooks, aggregateSegments, analyzeBilling, cacheHitEvidence, fileWriteCoverage, fmtTok, logicalCallEventsForTurn, resultOf } from '../format'
import type { Turn } from '../format'
import { sessionDiffSummary, sessionNetDiffSummary, turnDiffViewOf } from '../turn-diff'
import { addTurnCall, humanInterventions, turnCallKind, turnCallLabel, turnCallRowsFromMap, turnUserPreview, type TurnCallItem, type TurnCallKind, type TurnCallRow } from './overview-turn-calls'

export type OverviewPanelModel = ReturnType<typeof useOverviewPanelModel>

export function useOverviewPanelModel({
  turns,
  runtimeProvider,
  busy,
  gitDiff
}: {
  turns: Turn[]
  runtimeProvider?: RuntimeProvider
  busy: boolean
  gitDiff?: WorkspaceDiffResult | null
}) {
  const all = useMemo(() => turns.flatMap((t) => t.items), [turns])
  const compactions = useMemo(
    () => all.filter((event) => contextCompactionOf(event) != null),
    [all]
  )
  const sessionInterventions = useMemo(() => humanInterventions(all), [all])
  const sessionQuestions = sessionInterventions.reduce(
    (total, intervention) => total + intervention.request.questions.length,
    0
  )
  const sessionWaitMs = sessionInterventions.reduce((total, intervention) => total + intervention.durationMs, 0)
  const sessionClarifications = sessionInterventions.filter((intervention) => intervention.kind === 'clarification').length
  const sessionPermissions = sessionInterventions.filter((intervention) => intervention.kind === 'permission').length
  const results = useMemo(
    () => turns.map(resultOf).filter((event): event is TraceEvent => event != null),
    [turns]
  )
  const sumObserved = (pick: (event: TraceEvent) => number | undefined): { value: number | null; known: number } => {
    const values = results.map(pick).filter((value): value is number => value != null)
    return {
      value: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null,
      known: values.length
    }
  }
  const cost = sumObserved((e) => e.costUsd)
  const cacheHit = useMemo(() => cacheHitEvidence(results), [results])
  const isQoder = runtimeProvider === 'qoder_cli' || all.some((event) =>
    event.providerId === 'qoder' ||
    event.runtimeProvider === 'qoder_cli' ||
    event.billingProvider === 'qoder' ||
    event.upstreamProvider === 'qoder' ||
    event.contextProvider === 'qoder' ||
    event.creditUsage?.value?.provider === 'qoder' ||
    event.modelUsage?.some((usage) => usage.billingProvider === 'qoder' || usage.upstreamProvider === 'qoder')
  )
  const qoderCreditEvidence = useMemo(() => turns.flatMap((turn) => {
    const evidence = [...turn.items].reverse().find((event) => event.creditUsage?.value?.provider === 'qoder')?.creditUsage
    return evidence?.value ? [evidence] : []
  }), [turns])
  const qoderCredits = qoderCreditEvidence
    .map((evidence) => evidence.value?.amount)
    .filter((amount): amount is number => amount != null)
    .reduce((sum, amount) => sum + amount, 0)
  const qoderCreditKnown = qoderCreditEvidence.some((evidence) => evidence.value?.amount != null)
  const qoderCreditPartial = qoderCreditEvidence.some((evidence) => evidence.status === 'partial' || (evidence.value?.missingRequests ?? 0) > 0) || qoderCreditEvidence.length < turns.length
  // Use request-level live samples as well as canonical turn results, without summing snapshots.
  const ctx = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const result = resultOf(turns[i])
      for (let j = turns[i].items.length - 1; j >= 0; j--) {
        const event = turns[i].items[j]
        if (contextCompactionOf(event)) return null
        if (event.id !== result?.id && event.stage !== 'context_usage') continue
        const evidence = contextUsageEvidence(result && event.id === result.id ? result : event)
        // A new model with no known window must not inherit the old model's percentage.
        if (!evidence && event.stage === 'context_usage') return null
        if (evidence) {
          return {
            used: evidence.used,
            win: evidence.window,
            pct: Math.round((evidence.used / evidence.window) * 100),
            model: evidence.model,
            quality: evidence.quality,
            source: evidence.source
          }
        }
      }
    }
    return null
  }, [turns])
  const contextDescription = ctx
    ? `上下文${ctx.model ? ` · ${ctx.model}` : ''} · 已占 ${ctx.pct}% · 残余 ${fmtTok(Math.max(0, ctx.win - ctx.used))} · ${
      ctx.quality === 'inferred'
        ? '推断：Provider usage 比例换算'
        : ctx.quality === 'exact'
          ? '精确：最近一次 Provider 请求用量'
          : '旧记录：证据质量未标记'
    }${busy ? ' · 随请求用量上报更新，非逐 token' : ''}`
    : '仅在 Provider 同时上报上下文占用与模型窗口时显示'
  const logicalCallEvents = useMemo(() => turns.flatMap((turn) => logicalCallEventsForTurn(turn.items, turn.userText)), [turns])
  const calls = useMemo(() => aggregateCalls(logicalCallEvents), [logicalCallEvents])
  const turnCallRows = useMemo<TurnCallRow[]>(() => {
    return turns
      .map((turn, index) => {
        const logicalEvents = logicalCallEventsForTurn(turn.items, turn.userText)
        const result = resultOf(turn) ?? null
        const turnDiffView = turnDiffViewOf(turn.items)
        const maps: Record<TurnCallKind, Map<string, number>> = {
          tool: new Map(),
          mcp: new Map(),
          skill: new Map(),
          agent: new Map()
        }
        let firstEvent: TraceEvent | null = null
        for (const ev of logicalEvents) {
          const kind = turnCallKind(ev)
          if (!kind) continue
          firstEvent ??= isInferredSkillLoad(ev) ? turn.items.find((item) => item.id === ev.id) ?? ev : ev
          if (kind === 'mcp') {
            for (const call of mcpCallsForEvent(ev)) {
              addTurnCall(maps.mcp, call.action ? `${call.server}.${call.action}` : call.server)
            }
            continue
          }
          addTurnCall(maps[kind], turnCallLabel(ev, kind))
        }
        const groups: Record<TurnCallKind, TurnCallItem[]> = {
          tool: turnCallRowsFromMap(maps.tool),
          mcp: turnCallRowsFromMap(maps.mcp),
          skill: turnCallRowsFromMap(maps.skill, true),
          agent: turnCallRowsFromMap(maps.agent)
        }
        const total = (Object.keys(groups) as TurnCallKind[]).reduce((sum, kind) => {
          return sum + groups[kind].reduce((inner, item) => inner + item.count, 0)
        }, 0)
        return {
          turnNo: index + 1,
          runId: turn.runId,
          total,
          firstEvent,
          result,
          groups,
          userText: turnUserPreview(turn.userText),
          timing: buildTurnTimingBreakdown(turn.items, logicalEvents, result ?? undefined),
          files: aggregateFiles(turn.items).structured,
          ...(turnDiffView ? { turnDiff: turnDiffView.turnDiff } : {}),
          turnDiffPreview: turnDiffView?.preview === true,
          hooks: aggregateHooks(turn.items),
          interventions: humanInterventions(turn.items),
          errors: overviewToolErrors(turn.items)
        }
      })
  }, [turns])
  const dangers = useMemo(() => all.filter((e) => e.danger && e.stage !== 'tool_result'), [all])
  const segments = useMemo(() => aggregateSegments(logicalCallEvents), [logicalCallEvents])
  const billing = useMemo(() => analyzeBilling(turns), [turns])
  const hasSkillSeg = segments.some((s) => s.skill !== '（无 skill）')
  const { structured } = useMemo(() => aggregateFiles(all), [all])
  const coverage = useMemo(() => fileWriteCoverage(all), [all])
  // TOP TOOLS：tool + mcp 合并排名（前 6），配 mini-bar。
  const topTools = useMemo(() => {
    const rows = [
      ...calls.tools.map((t) => ({ name: t.name, count: t.count })),
      ...calls.mcp.map((g) => ({ name: `mcp:${g.server}`, count: g.total }))
    ]
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
    const max = rows[0]?.count ?? 1
    return { rows, max }
  }, [calls])
  const hookSummary = useMemo(() => aggregateHooks(all), [all])
  const billingTokenText =
    billing.resultTurns === 0
      ? '等待 result'
      : `${billing.missingTokenResultCount > 0 ? '≥' : ''}${fmtTok(billing.totalTokens)}`

  // verdict 状态（诚实）：高危→bad；运行中/有报错/可疑→warn；否则 ok。error 绝不显绿。
  const dangerHi = dangers.filter((e) => e.danger!.level === 'danger').length
  const toolErrorRows = useMemo(() => overviewToolErrors(all), [all])
  const toolErrors = toolErrorRows.length
  const turnError = turns.some((t) => !!t.error)
  const hasError = toolErrors > 0 || turnError
  let vstate: 'ok' | 'warn' | 'bad' = 'ok'
  let judge = '轮次已结束'
  if (busy) {
    vstate = 'warn'
    const activeTurn = turns.find(turn => !turn.done && !turn.error)
    judge = backgroundWorkStatus(activeTurn && latestBackgroundWork(activeTurn.items))?.label ?? '运行中'
  } else if (dangerHi > 0) {
    vstate = 'bad'
    judge = `${dangerHi} 处高危操作`
  } else if (hasError) {
    vstate = 'warn'
    judge = toolErrors > 0 ? `轮次已结束 · ${toolErrors} 处工具报错` : '轮次已结束 · 有报错'
  } else if (dangers.length > 0) {
    vstate = 'warn'
    judge = `轮次已结束 · ${dangers.length} 处可疑操作`
  }
  const diffFiles = gitDiff?.files ?? []
  const diffAdd = diffFiles.reduce((s, d) => s + d.added, 0)
  const diffDel = diffFiles.reduce((s, d) => s + d.deleted, 0)
  const sessionNetDiff = useMemo(() => sessionNetDiffSummary(turns), [turns])
  const sessionActivity = useMemo(() => sessionDiffSummary(turns), [turns])
  const sessionNetResumed = sessionNetDiff?.baseline === 'resumed'
  const sessionNetHeading = sessionNetDiff
    ? sessionNetDiff.preview
      ? '本会话净改动（运行中预览）'
      : sessionNetResumed
        ? '本会话净改动（自恢复以来）'
        : '本会话净改动'
    : `本会话活动（${sessionActivity.turnCount} 轮快照累计）`
  const sessionNetSource = sessionNetDiff
    ? sessionNetDiff.preview
      ? '来源=运行中临时 Git 快照（基线 → 此刻）；本轮结束后由终态取代'
      : sessionNetResumed
        ? '来源=恢复会话时重锚的 Git 基线 → 当前工作树；+/− 只覆盖自恢复以来的净改动'
        : '来源=会话首轮前 Git 基线 → 当前工作树；+/− 是真实净改动'
    : '来源=旧会话每轮 Git 工作树快照；+/− 是累计活动量，不是当前工作树净改动'
  const sessionNetTitle = sessionNetDiff
    ? sessionNetDiff.preview
      ? '运行中的临时 Git 净改动快照；点击在右侧 Diff 中审阅，本轮结束后由终态取代'
      : sessionNetResumed
        ? '会话首轮前基线不在本次运行内；净改动只覆盖自在 Scry 中恢复该会话以来的真实 Git 变化，点击在右侧 Diff 中审阅'
        : '本会话从第一轮开始前基线到当前的真实 Git 净改动；点击在右侧 Diff 中审阅'
    : '旧会话仅有逐轮快照累计活动量：同一行跨轮反复改会重复计入，不等于工作树净改动'
  const sessionDiffRepoRoot = useMemo(() => {
    for (let index = turns.length - 1; index >= 0; index--) {
      const root = turns[index].items.find((item) => item.turnDiff?.repoRoot)?.turnDiff?.repoRoot
      if (root) return root
    }
    return undefined
  }, [turns])

  return {
    turns,
    all,
    compactions,
    sessionInterventions,
    sessionQuestions,
    sessionWaitMs,
    sessionClarifications,
    sessionPermissions,
    results,
    cost,
    cacheHit,
    isQoder,
    qoderCredits,
    qoderCreditKnown,
    qoderCreditPartial,
    ctx,
    contextDescription,
    logicalCallEvents,
    calls,
    turnCallRows,
    dangers,
    segments,
    billing,
    hasSkillSeg,
    structured,
    coverage,
    topTools,
    hookSummary,
    billingTokenText,
    dangerHi,
    toolErrorRows,
    toolErrors,
    turnError,
    hasError,
    vstate,
    judge,
    diffFiles,
    diffAdd,
    diffDel,
    sessionNetDiff,
    sessionActivity,
    sessionNetResumed,
    sessionNetHeading,
    sessionNetSource,
    sessionNetTitle,
    sessionDiffRepoRoot,
  }
}
