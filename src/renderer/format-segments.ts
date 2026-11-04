// 分段视图：按实际发生的 skill/MCP 调用把会话切段，聚合每段的 token/api/工具/文件/效率。
// 子 agent 没有独立 usage 时只计数，不把父轮 token 分摊给子 agent。
import { mcpCallsForEvent, type ModelUsageRow, type TraceEvent } from '@shared/trace'
import { resultWallTiming } from '@shared/result-timing'
import { basename } from './format-text'
import { hasTokenUsage, resultTokenTotal } from './format-usage'
import { logicalCallEventsForTurn } from './format-calls'
import type { Turn } from './format-types'

// P1 Segment View（RFC §8.3，通用不绑 workflow）：按会话里实际发生的 skill 调用把时间线切段，
// 每段聚合工具数/子 agent/读写/报错，回答「哪段最贵、哪段反复、哪个 skill 吃掉大头」。不假设任何特定 phase 名。
export interface Segment {
  skill: string // skill 名；首段无 skill 时为 '（无 skill）'
  tools: number // 本段普通 tool_use 数（不含切段的 skill 事件本身，也不含子 agent）
  agents: number // 本段子 agent / Task 调用数
  reads: number
  writes: number
  errors: number
}

const BASE_SEG = '（无 skill）'

export function aggregateSegments(items: TraceEvent[]): Segment[] {
  const segs: Segment[] = []
  let cur: Segment = { skill: BASE_SEG, tools: 0, agents: 0, reads: 0, writes: 0, errors: 0 }
  const keep = (s: Segment): boolean => s.skill !== BASE_SEG || s.tools > 0 || s.agents > 0
  for (const e of items) {
    if (e.stage === 'tool_result') {
      if (e.isError) cur.errors++ // 错误算进当前段
      continue
    }
    if (e.kind === 'skill') {
      if (keep(cur)) segs.push(cur)
      cur = { skill: e.name ?? 'skill', tools: 0, agents: 0, reads: 0, writes: 0, errors: 0 }
      continue
    }
    if (e.kind === 'tool') {
      cur.tools++
      if (e.fileOp === 'read') cur.reads++
      else if (e.fileOp === 'write' || e.fileOp === 'edit') cur.writes++
      if (e.isError) cur.errors++
    } else if (e.kind === 'agent') {
      cur.agents++
      if (e.isError) cur.errors++
    }
  }
  if (keep(cur)) segs.push(cur)
  return segs
}

// Segment View（蓝本 segments.html）：把会话按「活跃 context」切成段，每段聚合 token/api/工具/文件/效率。
// per-segment token = 段内各 turn 的 result usage 之和；% = 段 api / 总 api。
// 活跃 skill 跨 turn 携带（启发式：skill 注入后持续到下个 skill）——精确 active_skill 待后端 PR#7（spans.skill_name）。
export interface SegAct {
  label: string // R/W/E（文件 op）或工具名 / mcp:server / Task
  op?: 'r' | 'w' | 'e'
  count: number
  mcp?: boolean
  agent?: boolean
}
export interface RichSegment {
  kind: 'baseline' | 'skill' | 'mcp' | 'subagent'
  name: string // skill/agent/mcp 名；baseline 为 '—'
  turnStart: number // 1-based
  turnEnd: number
  cost: number
  totalTokens: number | null
  tokenKnownTurns: number
  tokenTotalTurns: number
  apiMs: number | null
  tools: number
  reads: number
  writes: number
  edits: number
  errors: number
  dangers: number
  pct: number // 段 apiMs / 总 apiMs
  acts: SegAct[]
  files: string[] // 触及文件 basename（前 4）
  repeatReads: number // 重读次数（同文件读 >1）
  effFactor: number // 总读 / 唯一读文件，>1 表示有重读
  costDeltaVsBase: number | null // vs 基线段的 cost 增幅 %
}
export interface SegmentReport {
  segments: RichSegment[]
  sessionTurns: number
  totalApiMs: number | null
  totalCost: number
  totalTokens: number | null
  tokenKnownTurns: number
  tokenTotalTurns: number
  skillSwitches: number
  subagents: number
}

function resultsOf(t: Turn | Pick<Turn, 'items'>): TraceEvent[] {
  return t.items.filter((e) => e.kind === 'harness' && e.stage === 'result')
}

function aggregateModelUsage(rows: ModelUsageRow[]): ModelUsageRow[] | undefined {
  if (rows.length === 0) return undefined
  const map = new Map<string, ModelUsageRow>()
  for (const row of rows) {
    const identity = `${row.upstreamProvider ?? ''}\0${row.model}`
    const prev =
      map.get(identity) ??
      ({
        model: row.model,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        costUsd: 0,
        costSource: row.costSource,
        costConfidence: row.costConfidence,
        costUnit: row.costUnit,
        contextWindow: row.contextWindow,
        billingProvider: row.billingProvider,
        upstreamProvider: row.upstreamProvider,
        accountLabel: row.accountLabel,
        usageSource: row.usageSource
      } satisfies ModelUsageRow)
    prev.inputTokens = (prev.inputTokens ?? 0) + (row.inputTokens ?? 0)
    prev.outputTokens = (prev.outputTokens ?? 0) + (row.outputTokens ?? 0)
    prev.reasoningTokens = (prev.reasoningTokens ?? 0) + (row.reasoningTokens ?? 0)
    prev.cacheReadTokens = (prev.cacheReadTokens ?? 0) + (row.cacheReadTokens ?? 0)
    prev.cacheCreationTokens = (prev.cacheCreationTokens ?? 0) + (row.cacheCreationTokens ?? 0)
    prev.cacheCreation5mTokens = (prev.cacheCreation5mTokens ?? 0) + (row.cacheCreation5mTokens ?? 0)
    prev.cacheCreation1hTokens = (prev.cacheCreation1hTokens ?? 0) + (row.cacheCreation1hTokens ?? 0)
    if (row.costUsd != null && prev.costUsd != null) prev.costUsd += row.costUsd
    else prev.costUsd = undefined
    if (prev.costSource !== row.costSource) prev.costSource = prev.costSource ?? row.costSource
    prev.costConfidence = prev.costConfidence ?? row.costConfidence
    prev.costUnit = prev.costUnit ?? row.costUnit
    prev.contextWindow = row.contextWindow ?? prev.contextWindow
    map.set(identity, prev)
  }
  return [...map.values()]
}

export function resultOf(t: Turn | Pick<Turn, 'items'>): TraceEvent | undefined {
  const observed = resultsOf(t)
  const archived = observed.filter((event) => event.text !== 'transcript assistant usage')
  const usageCandidates = archived.some(hasTokenUsage) ? archived : observed
  if (usageCandidates.length <= 1) return usageCandidates[0]
  // Claude SDK 的 continuation result 是累计快照；其他 Provider 当前上报增量 result。
  // 墙钟统一按所有 canonical result 的时间区间外包络计算，不能跟 usage 一起求和。
  const latestCandidate = usageCandidates[usageCandidates.length - 1]
  const results = latestCandidate.runtimeProvider === 'claude_sdk' ? [latestCandidate] : usageCandidates
  const last = results[results.length - 1]
  const wall = resultWallTiming(observed)
  const knownCosts = results.filter((e) => e.costUsd != null)
  const costKnown = knownCosts.length === results.length
  const modelUsage = aggregateModelUsage(results.flatMap((e) => e.modelUsage ?? []))
  const contextSource = [...results].reverse().find((event) => event.contextTokens != null)
  const sumObserved = (pick: (event: TraceEvent) => number | undefined): number | undefined => {
    const values = results.map(pick).filter((value): value is number => value != null)
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined
  }
  return {
    ...last,
    ...(wall ? { ts: wall.completedAt } : {}),
    costUsd: costKnown ? knownCosts.reduce((s, e) => s + (e.costUsd ?? 0), 0) : undefined,
    costSource: costKnown && results.every((e) => e.costSource === 'price_table') ? 'price_table' : last.costSource,
    costConfidence: costKnown ? last.costConfidence : undefined,
    costUnit: costKnown ? 'usd' : undefined,
    tokensIn: sumObserved((event) => event.tokensIn),
    tokensOut: sumObserved((event) => event.tokensOut),
    reasoningTokens: sumObserved((event) => event.reasoningTokens),
    cacheReadTokens: sumObserved((event) => event.cacheReadTokens),
    cacheCreationTokens: sumObserved((event) => event.cacheCreationTokens),
    cacheCreation5mTokens: sumObserved((event) => event.cacheCreation5mTokens),
    cacheCreation1hTokens: sumObserved((event) => event.cacheCreation1hTokens),
    durationApiMs: results.reduce((s, e) => s + (e.durationApiMs ?? 0), 0) || undefined,
    durationMs: wall?.durationMs,
    contextTokens: contextSource?.contextTokens,
    contextModel: contextSource?.contextModel,
    contextProvider: contextSource?.contextProvider,
    contextUsageSource: contextSource?.contextUsageSource,
    contextUsageQuality: contextSource?.contextUsageQuality,
    modelUsage: contextSource ? (modelUsage ?? contextSource.modelUsage) : modelUsage
  }
}

export function aggregateSegmentsRich(turns: Turn[]): SegmentReport {
  type TurnCtx = { kind: RichSegment['kind']; name: string }
  let activeSkill: string | null = null
  let skillSwitches = 0
  let subagents = 0
  const turnCtx: TurnCtx[] = turns.map((t) => {
    const items = logicalCallEventsForTurn(t.items, t.userText)
    const skillEv = items.find((e) => e.kind === 'skill')
    if (skillEv) {
      const nm = skillEv.name ?? 'skill'
      if (nm !== activeSkill) skillSwitches++
      activeSkill = nm
    }
    subagents += items.filter((e) => e.kind === 'agent').length
    // Provider 目前没有子 agent 独立 usage。不能因为本轮出现 Task/Agent，
    // 就把父轮的全部 Token/API 归到该子 agent；子 agent 只作为调用明细计数。
    if (activeSkill) return { kind: 'skill', name: activeSkill }
    const mcp = items.filter((e) => e.isMcp).length
    const other = items.filter((e) => e.kind === 'tool' && !e.isMcp).length
    if (mcp > 0 && mcp >= other) return { kind: 'mcp', name: items.find((e) => e.isMcp)?.mcpServer ?? 'mcp' }
    return { kind: 'baseline', name: '—' }
  })

  // 连续同 context 合并成段
  const groups: { ctx: TurnCtx; idx: number[] }[] = []
  turnCtx.forEach((c, i) => {
    const last = groups[groups.length - 1]
    if (last && last.ctx.kind === c.kind && last.ctx.name === c.name) last.idx.push(i)
    else groups.push({ ctx: c, idx: [i] })
  })

  const turnResults = turns.map((turn) => resultOf(turn))
  const apiValues = turnResults.map((result) => result?.durationApiMs).filter((value): value is number => value != null)
  const totalApiMs = apiValues.length > 0 ? apiValues.reduce((sum, value) => sum + value, 0) : null
  const totalCost = turnResults.reduce((sum, result) => sum + (result?.costUsd ?? 0), 0)
  const tokenKnownTurns = turnResults.filter(hasTokenUsage).length
  const totalTokens = tokenKnownTurns > 0
    ? turnResults.reduce((sum, result) => sum + (hasTokenUsage(result) ? resultTokenTotal(result) : 0), 0)
    : null

  const actLabels = (e: TraceEvent): SegAct[] => {
    if (e.kind === 'agent') return [{ label: e.name ?? 'Task', count: 0, agent: true }]
    if (e.isMcp) {
      const servers = mcpCallsForEvent(e).map((call) => call.server)
      return servers.map((server) => ({ label: `mcp:${server}`, count: 0, mcp: true }))
    }
    if (e.tool === 'Read') return [{ label: 'R', op: 'r', count: 0 }]
    if (e.tool === 'Write') return [{ label: 'W', op: 'w', count: 0 }]
    if (e.tool === 'Edit' || e.tool === 'MultiEdit' || e.tool === 'NotebookEdit') return [{ label: 'E', op: 'e', count: 0 }]
    return [{ label: e.tool ?? e.kind, count: 0 }]
  }

  const segments: RichSegment[] = groups.map((g) => {
    const segTurns = g.idx.map((i) => turns[i])
    const items = segTurns.flatMap((t) => logicalCallEventsForTurn(t.items, t.userText))
    const segmentResults = segTurns.map((turn) => resultOf(turn))
    const cost = segmentResults.reduce((sum, result) => sum + (result?.costUsd ?? 0), 0)
    const tokenKnownTurnsForSegment = segmentResults.filter(hasTokenUsage).length
    const totalTokensForSegment = tokenKnownTurnsForSegment > 0
      ? segmentResults.reduce((sum, result) => sum + (hasTokenUsage(result) ? resultTokenTotal(result) : 0), 0)
      : null
    const segmentApiValues = segmentResults.map((result) => result?.durationApiMs).filter((value): value is number => value != null)
    const apiMs = segmentApiValues.length > 0
      ? segmentApiValues.reduce((sum, value) => sum + value, 0)
      : null
    const actMap = new Map<string, SegAct>()
    let reads = 0
    let writes = 0
    let edits = 0
    let tools = 0
    let dangers = 0
    const readFiles = new Map<string, number>()
    const filesSet = new Set<string>()
    for (const e of items.filter((event) => event.stage !== 'tool_result')) {
      if (e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent') {
        const acts = actLabels(e)
        tools += acts.length
        for (const act of acts) {
          const cur = actMap.get(act.label) ?? act
          cur.count++
          actMap.set(act.label, cur)
        }
      }
      if (e.fileOp === 'read' && e.filePath) {
        reads++
        readFiles.set(e.filePath, (readFiles.get(e.filePath) ?? 0) + 1)
        filesSet.add(e.filePath)
      } else if (e.fileOp === 'write' && e.filePath) {
        writes++
        filesSet.add(e.filePath)
      } else if (e.fileOp === 'edit' && e.filePath) {
        edits++
        filesSet.add(e.filePath)
      }
      if (e.danger) dangers++
    }
    const errors = segTurns.flatMap((t) => t.items).filter((e) => e.stage === 'tool_result' && e.isError).length
    const uniqueReadFiles = readFiles.size
    const repeatReads = [...readFiles.values()].reduce((s, n) => s + Math.max(0, n - 1), 0)
    const effFactor = uniqueReadFiles > 0 ? reads / uniqueReadFiles : 1
    return {
      kind: g.ctx.kind,
      name: g.ctx.name,
      turnStart: g.idx[0] + 1,
      turnEnd: g.idx[g.idx.length - 1] + 1,
      cost,
      totalTokens: totalTokensForSegment,
      tokenKnownTurns: tokenKnownTurnsForSegment,
      tokenTotalTurns: segTurns.length,
      apiMs,
      tools,
      reads,
      writes,
      edits,
      errors,
      dangers,
      pct: totalApiMs != null && totalApiMs > 0 && apiMs != null ? (apiMs / totalApiMs) * 100 : 0,
      acts: [...actMap.values()].sort((a, b) => b.count - a.count),
      files: [...filesSet].map(basename).slice(0, 4),
      repeatReads,
      effFactor,
      costDeltaVsBase: null
    }
  })

  const base = segments.find((s) => s.kind === 'baseline' && s.cost > 0)
  if (base) {
    for (const s of segments) {
      if (s !== base && base.cost > 0) s.costDeltaVsBase = Math.round((s.cost / base.cost - 1) * 100)
    }
  }
  return {
    segments,
    sessionTurns: turns.length,
    totalApiMs,
    totalCost,
    totalTokens,
    tokenKnownTurns,
    tokenTotalTurns: turns.length,
    skillSwitches,
    subagents
  }
}
