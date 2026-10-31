// Token 用量分析：按轮次/模型聚合可验证 token、上下文占用与行动信号。缺证据的字段保持缺失，
// 不用 0 或绿色掩盖；工具/Skill/MCP 没有独立 token 字段，因此不做硬拆。
import { contextUsageEvidence, type TraceEvent } from '@shared/trace'
import { fmtTok, parseUserMessage } from './format-text'
import { hasTokenUsage, resultTokenTotal, tokenCacheAccounting, usageTokenTotal } from './format-usage'
import { aggregateCalls, logicalCallEventsForTurn } from './format-calls'
import { resultOf } from './format-segments'
import type { Turn } from './format-types'

export type BillingSignalSeverity = 'info' | 'warn' | 'bad'

export interface BillingTurnRow {
  turnNo: number
  runId: string
  label: string
  tokensTotal: number
  tokenKnown: boolean
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
  promptTokens: number
  contextTokens?: number
  contextWindow?: number
  contextPct?: number
  model?: string
  toolCount: number
  errorCount: number
  result?: TraceEvent
}

export interface BillingModelRow {
  model: string
  totalTokens: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextWindow?: number
}

export interface BillingSignal {
  severity: BillingSignalSeverity
  title: string
  detail: string
  action: string
  evidence?: TraceEvent
}

export interface BillingAnalysis {
  sourceLabel: string
  officialBillLabel: string
  tokenFormulaLabel: string
  totalTokens: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
  apiMs: number | null
  resultTurns: number
  knownTokenResultCount: number
  missingTokenResultCount: number
  tokenCoveragePct: number
  modelTokenCoveragePct: number
  workflowUnattributedTokens: number
  topTokenTurns: BillingTurnRow[]
  allTurnRows: BillingTurnRow[]
  models: BillingModelRow[]
  signals: BillingSignal[]
}

function cleanTurnLabel(t: Turn, turnNo: number): string {
  const parsed = parseUserMessage(t.userText)
  const raw = parsed.command || parsed.body.split('\n').find((line) => line.trim()) || `turn ${turnNo}`
  return raw.replace(/\s+/g, ' ').trim().slice(0, 96)
}

function hiddenSpendCommand(e: TraceEvent): boolean {
  if (e.tool !== 'Bash') return false
  const input = e.input as Record<string, unknown> | undefined
  const cmd = typeof input?.command === 'string' ? input.command : ''
  return /\b(openai|anthropic|gemini|openrouter)\b|curl\s+https?:\/\/api\./i.test(cmd)
}

export function analyzeBilling(turns: Turn[]): BillingAnalysis {
  const all = turns.flatMap((t) => t.items)
  const results = turns.map(resultOf).filter((event): event is TraceEvent => event != null)
  const tokenAccountingModes = new Set(results.map(tokenCacheAccounting))
  const tokenFormulaLabel = tokenAccountingModes.size === 1 && tokenAccountingModes.has('input_includes_cache')
    ? '输入（含缓存）+输出'
    : '输入+输出+缓存'

  const allTurnRows: BillingTurnRow[] = turns.map((t, i) => {
    const r = resultOf(t)
    const model = r?.modelUsage?.[0]
    const context = r ? contextUsageEvidence(r) : null
    const contextWindow = context?.window
    const contextTokens = context?.used
    const tokensTotal = resultTokenTotal(r)
    const tokenKnown = hasTokenUsage(r)
    const cacheAccounting = tokenCacheAccounting(r)
    const promptTokens =
      (r?.tokensIn ?? 0) +
      (cacheAccounting === 'separate' ? (r?.cacheReadTokens ?? 0) + (r?.cacheCreationTokens ?? 0) : 0)
    const toolCount = aggregateCalls(logicalCallEventsForTurn(t.items, t.userText)).totalCalls
    const errorCount = t.items.filter((e) => e.stage === 'tool_result' && e.isError).length
    return {
      turnNo: i + 1,
      runId: t.runId,
      label: cleanTurnLabel(t, i + 1),
      tokensTotal,
      tokenKnown,
      tokensIn: r?.tokensIn ?? 0,
      tokensOut: r?.tokensOut ?? 0,
      cacheReadTokens: r?.cacheReadTokens ?? 0,
      cacheCreationTokens: r?.cacheCreationTokens ?? 0,
      promptTokens,
      contextTokens,
      contextWindow,
      contextPct:
        contextTokens != null && contextWindow != null && contextWindow > 0
          ? Math.round((contextTokens / contextWindow) * 100)
          : undefined,
      model: context?.model ?? model?.model,
      toolCount,
      errorCount,
      result: r
    }
  })

  const tokensIn = results.reduce((s, e) => s + (e.tokensIn ?? 0), 0)
  const tokensOut = results.reduce((s, e) => s + (e.tokensOut ?? 0), 0)
  const cacheReadTokens = results.reduce((s, e) => s + (e.cacheReadTokens ?? 0), 0)
  const cacheCreationTokens = results.reduce((s, e) => s + (e.cacheCreationTokens ?? 0), 0)
  const totalTokens = results.reduce((sum, event) => sum + resultTokenTotal(event), 0)
  const knownTokenResultCount = results.filter(hasTokenUsage).length
  const missingTokenResultCount = Math.max(0, results.length - knownTokenResultCount)
  const apiValues = results
    .map((event) => event.durationApiMs)
    .filter((duration): duration is number => duration != null)
  const apiMs = apiValues.length > 0 ? apiValues.reduce((sum, duration) => sum + duration, 0) : null

  const modelMap = new Map<string, BillingModelRow>()
  for (const r of results) {
    for (const mu of r.modelUsage ?? []) {
      const prev =
        modelMap.get(mu.model) ??
        ({
          model: mu.model,
          totalTokens: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: mu.contextWindow
        } satisfies BillingModelRow)
      prev.tokensIn += mu.inputTokens ?? 0
      prev.tokensOut += mu.outputTokens ?? 0
      prev.cacheReadTokens += mu.cacheReadTokens ?? 0
      prev.cacheCreationTokens += mu.cacheCreationTokens ?? 0
      const accounting = tokenCacheAccounting({
        providerId: r.providerId,
        runtimeProvider: r.runtimeProvider,
        billingProvider: mu.billingProvider ?? r.billingProvider
      })
      prev.totalTokens = usageTokenTotal(
        prev.tokensIn,
        prev.tokensOut,
        prev.cacheReadTokens,
        prev.cacheCreationTokens,
        accounting
      )
      prev.contextWindow = prev.contextWindow ?? mu.contextWindow
      modelMap.set(mu.model, prev)
    }
  }
  const models = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut))
  const modelTokens = models.reduce((s, m) => s + m.totalTokens, 0)

  const signals: BillingSignal[] = []
  const maxCtx = [...allTurnRows].filter((r) => r.contextPct != null).sort((a, b) => (b.contextPct ?? 0) - (a.contextPct ?? 0))[0]
  if (maxCtx?.contextPct != null && maxCtx.contextPct >= 80) {
    const severity: BillingSignalSeverity = maxCtx.contextPct >= 100 ? 'bad' : maxCtx.contextPct >= 95 ? 'bad' : 'warn'
    signals.push({
      severity,
      title: `上下文 ${maxCtx.contextPct}%`,
      detail: `TURN ${String(maxCtx.turnNo).padStart(2, '0')} · ${fmtTok(maxCtx.contextTokens)} / ${fmtTok(maxCtx.contextWindow)}`,
      action: maxCtx.contextPct >= 95 ? '建议 compact 或拆新 session' : '继续前留意上下文膨胀',
      evidence: maxCtx.result
    })
  }

  const knownTokenRows = allTurnRows.filter((r) => r.result && r.tokenKnown)
  const tokenSpike = knownTokenRows
    .map((row, index) => {
      const previous = knownTokenRows.slice(0, index)
      const previousAverage = previous.length > 0 ? previous.reduce((sum, candidate) => sum + candidate.tokensTotal, 0) / previous.length : 0
      const relativeSpike = previous.length > 0 && row.tokensTotal > 5_000 && previousAverage > 0 && row.tokensTotal >= previousAverage * 2
      const highAbsoluteUsage = row.tokensTotal >= 100_000
      return relativeSpike || highAbsoluteUsage ? { row, relativeSpike, previousAverage } : null
    })
    .filter((candidate): candidate is { row: BillingTurnRow; relativeSpike: boolean; previousAverage: number } => candidate != null)
    .sort((a, b) => Number(b.relativeSpike) - Number(a.relativeSpike) || b.row.tokensTotal - a.row.tokensTotal)[0]
  if (tokenSpike) {
    const { row, relativeSpike, previousAverage } = tokenSpike
    signals.push({
      severity: row.tokensTotal >= 250_000 ? 'bad' : 'warn',
      title: `${relativeSpike ? 'Token 突增' : '高 Token 轮次'} ${fmtTok(row.tokensTotal)}`,
      detail: relativeSpike
        ? `TURN ${String(row.turnNo).padStart(2, '0')} · 达到此前已捕获轮次均值 ${fmtTok(previousAverage)} 的 2× · 工具 ${row.toolCount} 次`
        : `TURN ${String(row.turnNo).padStart(2, '0')} · 总 Token 达到 100.0k 规则阈值 · 工具 ${row.toolCount} 次 · 输入/输出 ${fmtTok(row.tokensIn + row.tokensOut)}`,
      action: '展开该 turn 的 model/cache/tool 证据，必要时拆任务',
      evidence: row.result
    })
  }

  const repeatInTurn = turns
    .map((t, i) => {
      const calls = aggregateCalls(logicalCallEventsForTurn(t.items, t.userText))
      const top = [
        ...calls.tools.map((tool) => [tool.name, tool.count] as const),
        ...calls.mcp.map((group) => [`mcp:${group.server}`, group.total] as const)
      ].sort((a, b) => b[1] - a[1])[0]
      return top ? { turn: allTurnRows[i], name: top[0], count: top[1] } : null
    })
    .filter((x): x is { turn: BillingTurnRow; name: string; count: number } => !!x && x.count >= 8)[0]
  if (repeatInTurn) {
    signals.push({
      severity: 'warn',
      title: `高频工具调用 ${repeatInTurn.name} ${repeatInTurn.count}×`,
      detail: `TURN ${String(repeatInTurn.turn.turnNo).padStart(2, '0')} · 单轮调用达到频次阈值（8 次）；频次本身不等同于循环`,
      action: '展开该轮，区分合理批处理与重复重试',
      evidence: repeatInTurn.turn.result
    })
  }

  const errorByTool = new Map<string, { count: number; ev?: TraceEvent }>()
  for (const e of all) {
    if (e.stage !== 'tool_result' || !e.isError) continue
    const toolUse = all.find((x) => x.toolUseId && x.toolUseId === e.toolUseId && x.stage !== 'tool_result')
    const name = toolUse?.isMcp ? `mcp:${toolUse.mcpServer ?? '?'}` : (toolUse?.tool ?? e.tool ?? 'tool')
    const cur = errorByTool.get(name) ?? { count: 0, ev: toolUse ?? e }
    cur.count++
    errorByTool.set(name, cur)
  }
  const errors = [...errorByTool.entries()].sort((a, b) => b[1].count - a[1].count)[0]
  if (errors) {
    signals.push({
      severity: errors[1].count >= 3 ? 'bad' : 'warn',
      title: `${errors[0]} 失败 ${errors[1].count}×`,
      detail: '工具结果里出现 error',
      action: '优先检查失败输出，避免继续消耗上下文重试',
      evidence: errors[1].ev
    })
  }

  const subagent = turns
    .map((turn, index) => {
      const logical = logicalCallEventsForTurn(turn.items, turn.userText).filter(
        (event) => event.stage !== 'tool_result' && (event.kind === 'tool' || event.kind === 'skill' || event.kind === 'agent')
      )
      const roots = logical.filter((event) => event.kind === 'agent')
      if (roots.length === 0) return null
      const descendantIds = new Set(roots.flatMap((event) => event.toolUseId ? [event.toolUseId] : []))
      const descendants: TraceEvent[] = []
      let changed = true
      while (changed) {
        changed = false
        for (const event of logical) {
          if (roots.includes(event) || descendants.includes(event)) continue
          const linkedByParent = event.parentToolUseId != null && descendantIds.has(event.parentToolUseId)
          if (linkedByParent) {
            descendants.push(event)
            if (event.toolUseId && !descendantIds.has(event.toolUseId)) {
              descendantIds.add(event.toolUseId)
              changed = true
            }
          }
        }
      }
      return descendants.length >= 20
        ? { row: allTurnRows[index], calls: descendants.length, evidence: roots[0] }
        : null
    })
    .filter((candidate): candidate is { row: BillingTurnRow; calls: number; evidence: TraceEvent } => candidate != null)
    .sort((left, right) => right.calls - left.calls)[0]
  if (subagent) {
    signals.push({
      severity: subagent.calls >= 40 ? 'bad' : 'warn',
      title: `子 agent 调用 ${subagent.calls} 次`,
      detail: `TURN ${String(subagent.row.turnNo).padStart(2, '0')} · Provider 未上报子 agent 独立 Token/API`,
      action: '确认子 agent 是否仍在必要范围内',
      evidence: subagent.evidence
    })
  }

  const hiddenSpend = all.find(hiddenSpendCommand)
  if (hiddenSpend) {
    signals.push({
      severity: 'info',
      title: '可能存在外部用量盲区',
      detail: 'Bash 中出现 provider CLI/API 调用迹象',
      action: 'Scry 只能统计当前 transcript token；外部 CLI/API 用量需要 adapter',
      evidence: hiddenSpend
    })
  }

  return {
    sourceLabel: '本会话可验证 token',
    officialBillLabel: '仅看 token，不算金额',
    tokenFormulaLabel,
    totalTokens,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    apiMs,
    resultTurns: results.length,
    knownTokenResultCount,
    missingTokenResultCount,
    tokenCoveragePct: results.length > 0 ? Math.round((knownTokenResultCount / results.length) * 100) : 0,
    modelTokenCoveragePct: totalTokens > 0 ? Math.min(100, Math.round((modelTokens / totalTokens) * 100)) : knownTokenResultCount > 0 ? 100 : 0,
    workflowUnattributedTokens: totalTokens,
    topTokenTurns: [...allTurnRows].filter((r) => r.tokenKnown && r.tokensTotal > 0).sort((a, b) => b.tokensTotal - a.tokensTotal).slice(0, 10),
    allTurnRows,
    models,
    signals
  }
}
