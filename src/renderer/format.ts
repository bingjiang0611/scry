// renderer 共享的纯逻辑：常量 / 视图类型 / 格式化与投影 helper。无 React 依赖，给各组件复用。
import { maskSecrets, type TraceEvent, type DiffFile, type McpLiveStatus, type ModelUsageRow } from '@shared/trace'
import type { AgentInputAttachment } from '@shared/runtime'

// 视觉升级：值改成 Icon 名（蓝本 SVG 图标），消费处用 <Icon name={...}>。
export const AGENT_ICON: Record<string, string> = {
  claude: 'cube',
  codex: 'square',
  cursor: 'square',
  gemini: 'square',
  qoder: 'square'
}

export const KIND_ICON: Record<string, string> = {
  human: 'message',
  model: 'bulb',
  tool: 'tool',
  skill: 'box',
  agent: 'cube',
  harness: 'check',
  hook: 'clock'
}

export interface FileRow {
  path: string
  read: number
  write: number
  edit: number
}

// P2 Files（RFC §8.4）：写/改文件的「读覆盖」——第一次写入前有没有先读。
// tool_result 会继承 fileOp/filePath，必须排除；写后补读不反向洗掉盲改风险。
export interface FileCoverage {
  written: number // 写或改过的文件数
  readBefore: number // 第一次写或改之前已读过的文件数
  blind: string[] // 第一次写或改之前未读过的文件路径（风险）
}

export function fileWriteCoverage(items: TraceEvent[]): FileCoverage {
  const read = new Set<string>()
  const written = new Set<string>()
  const covered = new Set<string>()
  const pending = new Map<string, TraceEvent[]>()
  const applyCompleted = (event: TraceEvent): void => {
    if (!event.fileOp || !event.filePath) return
    if (event.fileOp === 'read') {
      read.add(event.filePath)
      return
    }
    if (written.has(event.filePath)) return
    written.add(event.filePath)
    if (read.has(event.filePath)) covered.add(event.filePath)
  }
  for (const event of items) {
    if (event.stage === 'tool_result') {
      if (!event.toolUseId) continue
      const completed = pending.get(event.toolUseId) ?? []
      pending.delete(event.toolUseId)
      if (event.isError) continue
      for (const started of completed) applyCompleted(started)
      continue
    }
    if (!event.fileOp || !event.filePath) continue
    if (!event.toolUseId) {
      // CLI 的 file_op 是完成态事实，不另发 tool_result。
      applyCompleted(event)
      continue
    }
    const sameCall = pending.get(event.toolUseId) ?? []
    sameCall.push(event)
    pending.set(event.toolUseId, sameCall)
  }
  const blind = [...written].filter((path) => !covered.has(path))
  return { written: written.size, readBefore: covered.size, blind }
}

export interface Turn {
  runId: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done: boolean
  error?: string
  errorHint?: string
}

export interface McpStatus {
  testing?: boolean
  ok?: boolean
  tools?: number
  toolNames?: string[]
  error?: string
}

export function updateMcpLiveAfterToggle(live: McpLiveStatus[], name: string, enabled: boolean): McpLiveStatus[] {
  const status: McpLiveStatus['status'] = enabled ? 'pending' : 'disabled'
  let seen = false
  const next = live.map((l) => {
    if (l.name !== name) return l
    seen = true
    return { ...l, status }
  })
  return seen ? next : [...next, { name, status }]
}

export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

export function fmtTok(n?: number | null): string {
  if (n == null) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function usageTokenTotal(input = 0, output = 0, cacheRead = 0, cacheCreation = 0): number {
  return input + output + cacheRead + cacheCreation
}

function resultTokenTotal(e: TraceEvent | undefined): number {
  return usageTokenTotal(e?.tokensIn ?? 0, e?.tokensOut ?? 0, e?.cacheReadTokens ?? 0, e?.cacheCreationTokens ?? 0)
}

function hasTokenUsage(e: TraceEvent | undefined): boolean {
  return !!e && (e.tokensIn != null || e.tokensOut != null || e.cacheReadTokens != null || e.cacheCreationTokens != null)
}

export function relTime(ms: number): string {
  const d = Date.now() - ms
  if (d < 3600000) return `${Math.max(1, Math.round(d / 60000))}m`
  const h = d / 3600000
  if (h < 24) return `${Math.round(h)}h`
  const days = h / 24
  if (days < 7) return `${Math.round(days)}d`
  if (days < 30) return `${Math.round(days / 7)}w`
  return `${Math.round(days / 30)}mo`
}

export function bashFiles(cmd: string): string[] {
  const out = new Set<string>()
  for (const raw of cmd.split(/[\s;|&><()]+/)) {
    const t = raw.replace(/['"`]/g, '')
    if (!t || t.startsWith('-')) continue
    if (t.startsWith('/dev/')) continue // /dev/null 等重定向目标不是文件足迹（basename 会显示成 "null"）
    const looksLikeFile = /\.[A-Za-z0-9]{1,6}$/.test(t) || (t.includes('/') && !/^https?:/.test(t))
    if (looksLikeFile && t.length > 1) out.add(t)
  }
  return [...out].slice(0, 12)
}

export function toolDisplayName(ev: TraceEvent): string {
  if (ev.kind === 'agent') return 'Task'
  if (ev.kind === 'skill') return 'Skill'
  if (ev.kind === 'hook') return hookCommandLabel(ev.hookCommand) ?? ev.hookName ?? ev.tool ?? 'Hook'
  return ev.tool ?? ev.stage
}

export function toolArg(ev: TraceEvent): string {
  if (ev.filePath) return basename(ev.filePath)
  const inp = ev.input as Record<string, unknown> | undefined
  if (typeof inp?.command === 'string') return inp.command.slice(0, 80)
  if (typeof inp?.pattern === 'string') return inp.pattern
  if (typeof inp?.subagent_type === 'string') return inp.subagent_type
  if (typeof inp?.description === 'string') return inp.description
  return ev.name ?? ''
}

export function toolMeta(ev: TraceEvent): string {
  const inp = ev.input as Record<string, unknown> | undefined
  if (ev.tool === 'Write' && typeof inp?.content === 'string') {
    return `${inp.content.split('\n').length} lines`
  }
  return ''
}

// 调用明细（本会话）：把 tool_use 事件按 工具/skill/子agent/mcp 分类计数，供右栏监控/定位。
// 只数 tool_use（排除 stage==='tool_result'，否则每次调用会被结果事件重复计一遍）。
export interface CallCount {
  name: string
  count: number
}
export interface McpGroup {
  server: string
  total: number
  actions: { action: string; tool: string; count: number }[] // tool = mcpTool 或原始 tool（用于 jump 定位）
}
export interface CallBreakdown {
  tools: CallCount[] // 普通工具（kind=tool，非 mcp）
  skills: CallCount[] // kind=skill
  agents: CallCount[] // kind=agent（子 agent / Task）
  mcp: McpGroup[] // kind=tool && isMcp，按 server 分组
  toolTotal: number // 全部 tool_use 数（tool+skill+agent+mcp，已排除 tool_result）
}

export function aggregateCalls(items: TraceEvent[]): CallBreakdown {
  const tools = new Map<string, number>()
  const skills = new Map<string, number>()
  const agents = new Map<string, number>()
  const mcpMap = new Map<string, McpGroup>()
  let toolTotal = 0
  for (const e of items) {
    if (e.stage === 'tool_result') continue // 工具结果不是一次调用，跳过
    if (e.kind === 'skill') {
      const n = e.name ?? 'skill'
      skills.set(n, (skills.get(n) ?? 0) + 1)
      toolTotal++
    } else if (e.kind === 'agent') {
      const n = e.name ?? 'agent'
      agents.set(n, (agents.get(n) ?? 0) + 1)
      toolTotal++
    } else if (e.kind === 'tool' && e.isMcp) {
      const server = e.mcpServer ?? '?'
      const tool = e.mcpTool ?? e.tool ?? ''
      const action = e.mcpAction ?? ((e.tool ?? '').split('__').slice(2).join('__') || tool) // mcp__server__action → action
      let g = mcpMap.get(server)
      if (!g) {
        g = { server, total: 0, actions: [] }
        mcpMap.set(server, g)
      }
      g.total++
      const a = g.actions.find((x) => x.tool === tool)
      if (a) a.count++
      else g.actions.push({ action, tool, count: 1 })
      toolTotal++
    } else if (e.kind === 'tool') {
      const n = e.tool ?? e.stage
      tools.set(n, (tools.get(n) ?? 0) + 1)
      toolTotal++
    }
  }
  const toRows = (m: Map<string, number>): CallCount[] =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const mcp = [...mcpMap.values()].sort((a, b) => b.total - a.total)
  for (const g of mcp) g.actions.sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
  return { tools: toRows(tools), skills: toRows(skills), agents: toRows(agents), mcp, toolTotal }
}

export interface HookScriptRow {
  key: string
  event: string
  trigger: string
  label: string
  command?: string
  rawEvents: number
  logicalRuns: number
  responses: number
  pending: number
  started: number
  progress: number
  errors: number
  cancelled: number
  outcome?: string
  exitCode?: number
  last?: TraceEvent
  lastError?: TraceEvent
  lastCancelled?: TraceEvent
  unsuccessful: TraceEvent[]
  failureSummary?: string
}

export interface HookGroup {
  key: string
  event: string
  trigger: string
  rawEvents: number
  logicalRuns: number
  responses: number
  pending: number
  errors: number
  cancelled: number
  toolCalls: number
  last?: TraceEvent
  scripts: HookScriptRow[]
}

export interface HookSummary {
  rawEvents: number
  logicalRuns: number
  responses: number
  pending: number
  groups: HookGroup[]
}

function hookCommandFromEvent(e: TraceEvent): string | undefined {
  if (e.hookCommand) return e.hookCommand
  const input = e.input as Record<string, unknown> | undefined
  return typeof input?.command === 'string' ? input.command : undefined
}

export type HookCancellationKind = 'timeout' | 'suspected-timeout' | 'cancelled'

export interface HookCancellationDetail {
  kind: HookCancellationKind
  durationMs?: number
  timeoutMs?: number
  timeoutSource?: 'upstream' | 'current-config'
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizedCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

export function hookCancellationDetail(event: TraceEvent | undefined): HookCancellationDetail | undefined {
  if (!event || event.hookOutcome !== 'cancelled') return undefined
  const input = event.input as Record<string, unknown> | undefined
  const durationMs = positiveNumber(event.durationMs) ?? positiveNumber(input?.durationMs)
  const explicitTimeoutMs = positiveNumber(input?.timeoutMs)
  const explicitlyTimedOut = typeof input?.timedOut === 'boolean' ? input.timedOut : undefined
  const command = hookCommandFromEvent(event)
  const configured = command
    ? event.hookConfiguredCommands?.find(
        (candidate) => normalizedCommand(candidate.command) === normalizedCommand(command)
      )
    : undefined
  const configuredTimeoutSeconds = positiveNumber(configured?.timeoutSeconds)
  const configuredTimeoutMs = configuredTimeoutSeconds != null ? configuredTimeoutSeconds * 1000 : undefined

  if (explicitlyTimedOut === true) {
    return {
      kind: 'timeout',
      durationMs,
      timeoutMs: explicitTimeoutMs ?? configuredTimeoutMs,
      timeoutSource: explicitTimeoutMs != null ? 'upstream' : configuredTimeoutMs != null ? 'current-config' : undefined
    }
  }
  if (explicitlyTimedOut !== false) {
    const timeoutMs = explicitTimeoutMs ?? configuredTimeoutMs
    if (durationMs != null && timeoutMs != null && durationMs >= timeoutMs) {
      return {
        kind: 'suspected-timeout',
        durationMs,
        timeoutMs,
        timeoutSource: explicitTimeoutMs != null ? 'upstream' : 'current-config'
      }
    }
  }
  return { kind: 'cancelled', durationMs }
}

function cleanCommandToken(raw: string): string {
  return raw.trim().replace(/^['"`]+|['"`;,]+$/g, '')
}

export function hookCommandLabel(command: string | undefined): string | undefined {
  if (!command) return undefined
  const tokens = command.match(/"[^"]+"|'[^']+'|`[^`]+`|\S+/g) ?? []
  const runners = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'node', 'npx', 'uv', 'env'])
  for (const raw of tokens) {
    const t = cleanCommandToken(raw)
    if (!t || t.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue
    const base = basename(t)
    if (runners.has(base) || base === 'true' || base === 'false') continue
    if (t.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(t)) return base
  }
  return command.trim().slice(0, 80)
}

type HookScriptDraft = Omit<HookScriptRow, 'logicalRuns' | 'pending'> & {
  pendingKeys: Set<string>
  responseKeys: Set<string>
}

type HookGroupDraft = Omit<HookGroup, 'logicalRuns' | 'responses' | 'pending' | 'scripts'> & {
  scripts: Map<string, HookScriptDraft>
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function hookEventFailureSummary(e: TraceEvent): string | undefined {
  const input = e.input as Record<string, unknown> | undefined
  const pieces = [
    stringField(input?.stderr),
    stringField(input?.stdout),
    stringField(input?.content),
    stringField(e.output),
    stringField(e.text)
  ]
  const message = pieces.find(Boolean)
  const exitCode = e.hookExitCode ?? (typeof input?.exitCode === 'number' ? input.exitCode : undefined)
  const prefix = exitCode != null ? `exit ${exitCode}` : e.hookOutcome === 'error' ? 'hook error' : undefined
  if (message) {
    const clean = message.replace(/\s+/g, ' ').trim()
    return prefix ? `${prefix}: ${clean}` : clean
  }
  if (prefix) return prefix
  if (e.hookOutcome) return e.hookOutcome
  return undefined
}

function hookTriggerSubject(event: string, trigger: string): string {
  const prefix = `${event}:`
  return trigger.startsWith(prefix) ? trigger.slice(prefix.length) : trigger
}

function toolCallsForHook(items: TraceEvent[], event: string, trigger: string): number {
  const subject = hookTriggerSubject(event, trigger)
  if (!subject || subject === trigger) return 0
  const calls = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'skill' && item.kind !== 'agent') continue
    if (item.stage === 'tool_result' || (item.tool ?? item.name) !== subject) continue
    calls.add(item.toolUseId ?? item.id)
  }
  return calls.size
}

export function aggregateHooks(items: TraceEvent[]): HookSummary {
  const hooks = items.filter((e) => e.kind === 'hook')
  const groups = new Map<string, HookGroupDraft>()
  const commandsByRun = new Map<string, Set<string>>()

  for (const e of hooks) {
    const command = hookCommandFromEvent(e)
    if (!command || !e.hookId) continue
    const event = e.hookEvent ?? e.name ?? 'Hook'
    const trigger = e.hookName ?? e.tool ?? 'hook'
    const runKey = `${event}\u0000${trigger}\u0000${e.hookId}`
    const commands = commandsByRun.get(runKey) ?? new Set<string>()
    commands.add(command)
    commandsByRun.set(runKey, commands)
  }

  for (const e of hooks) {
    const event = e.hookEvent ?? e.name ?? 'Hook'
    const trigger = e.hookName ?? e.tool ?? 'hook'
    const groupKey = `${event}\u0000${trigger}`
    let group = groups.get(groupKey)
    if (!group) {
      group = { key: groupKey, event, trigger, rawEvents: 0, errors: 0, cancelled: 0, toolCalls: 0, scripts: new Map() }
      groups.set(groupKey, group)
    }

    const explicitCommand = hookCommandFromEvent(e)
    const runCommands = e.hookId ? commandsByRun.get(`${event}\u0000${trigger}\u0000${e.hookId}`) : undefined
    const command = explicitCommand ?? (runCommands?.size === 1 ? [...runCommands][0] : undefined)
    const label = hookCommandLabel(command) ?? trigger
    const scriptKey = `${groupKey}\u0000${command ?? label}`
    let script = group.scripts.get(scriptKey)
    if (!script) {
      script = {
        key: scriptKey,
        event,
        trigger,
        label,
        command,
        rawEvents: 0,
        responses: 0,
        started: 0,
        progress: 0,
        errors: 0,
        cancelled: 0,
        unsuccessful: [],
        pendingKeys: new Set(),
        responseKeys: new Set()
      }
      group.scripts.set(scriptKey, script)
    }

    group.rawEvents++
    script.rawEvents++
    if (e.stage === 'hook_response') {
      const responseKey = e.hookId ?? e.id
      const firstResponse = !script.responseKeys.has(responseKey)
      script.responseKeys.add(responseKey)
      script.outcome = e.hookOutcome
      script.exitCode = e.hookExitCode
      if (firstResponse && e.hookOutcome === 'cancelled') {
        group.cancelled++
        script.cancelled++
        script.lastCancelled = e
      }
      if (firstResponse && (e.isError || e.hookOutcome === 'error' || e.hookOutcome === 'failure' || e.hookOutcome === 'cancelled')) {
        script.unsuccessful.push(e)
      }
    } else {
      script.pendingKeys.add(e.hookId ?? e.id)
      if (e.stage === 'hook_started') script.started++
      else script.progress++
    }
    if (e.isError) {
      group.errors++
      script.errors++
      script.lastError = e
      script.failureSummary = hookEventFailureSummary(e)
    }
    group.last = e
    script.last = e
  }

  const finalized = [...groups.values()].map((g) => {
    const scripts = [...g.scripts.values()]
      .map((s) => {
        const pending = [...s.pendingKeys].filter((key) => !s.responseKeys.has(key)).length
        const logicalRuns = new Set([...s.pendingKeys, ...s.responseKeys]).size
        const responses = s.responseKeys.size
        const { pendingKeys: _pendingKeys, responseKeys: _responseKeys, ...row } = s
        return { ...row, responses, pending, logicalRuns }
      })
      .sort((a, b) => b.logicalRuns - a.logicalRuns || b.rawEvents - a.rawEvents || a.label.localeCompare(b.label))
    const responses = scripts.reduce((sum, s) => sum + s.responses, 0)
    const pending = scripts.reduce((sum, s) => sum + s.pending, 0)
    const logicalRuns = responses + pending
    return { ...g, toolCalls: toolCallsForHook(items, g.event, g.trigger), scripts, responses, pending, logicalRuns }
  })

  finalized.sort(
    (a, b) =>
      b.logicalRuns - a.logicalRuns ||
      b.rawEvents - a.rawEvents ||
      a.event.localeCompare(b.event) ||
      a.trigger.localeCompare(b.trigger)
  )

  return {
    rawEvents: hooks.length,
    logicalRuns: finalized.reduce((sum, g) => sum + g.logicalRuns, 0),
    responses: finalized.reduce((sum, g) => sum + g.responses, 0),
    pending: finalized.reduce((sum, g) => sum + g.pending, 0),
    groups: finalized
  }
}

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
  totalTokens: number
  apiMs: number
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
  totalApiMs: number
  totalCost: number
  totalTokens: number
  skillSwitches: number
  subagents: number
}

function resultsOf(t: Turn): TraceEvent[] {
  return t.items.filter((e) => e.kind === 'harness' && e.stage === 'result')
}

function aggregateModelUsage(rows: ModelUsageRow[]): ModelUsageRow[] | undefined {
  if (rows.length === 0) return undefined
  const map = new Map<string, ModelUsageRow>()
  for (const row of rows) {
    const prev =
      map.get(row.model) ??
      ({
        model: row.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        costUsd: 0,
        costSource: row.costSource,
        costConfidence: row.costConfidence,
        costUnit: row.costUnit,
        contextWindow: row.contextWindow
      } satisfies ModelUsageRow)
    prev.inputTokens = (prev.inputTokens ?? 0) + (row.inputTokens ?? 0)
    prev.outputTokens = (prev.outputTokens ?? 0) + (row.outputTokens ?? 0)
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
    map.set(row.model, prev)
  }
  return [...map.values()]
}

export function resultOf(t: Turn): TraceEvent | undefined {
  const observed = resultsOf(t)
  const archived = observed.filter((event) => event.text !== 'transcript assistant usage')
  const results = archived.some(hasTokenUsage) ? archived : observed
  if (results.length <= 1) return results[0]
  const last = results[results.length - 1]
  const knownCosts = results.filter((e) => e.costUsd != null)
  const costKnown = knownCosts.length === results.length
  const modelUsage = aggregateModelUsage(results.flatMap((e) => e.modelUsage ?? []))
  const contextSource = [...results].reverse().find((e) => e.contextTokens != null || e.modelUsage?.some((m) => m.contextWindow))
  const sumObserved = (pick: (event: TraceEvent) => number | undefined): number | undefined => {
    const values = results.map(pick).filter((value): value is number => value != null)
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined
  }
  return {
    ...last,
    costUsd: costKnown ? knownCosts.reduce((s, e) => s + (e.costUsd ?? 0), 0) : undefined,
    costSource: costKnown && results.every((e) => e.costSource === 'price_table') ? 'price_table' : last.costSource,
    costConfidence: costKnown ? last.costConfidence : undefined,
    costUnit: costKnown ? 'usd' : undefined,
    tokensIn: sumObserved((event) => event.tokensIn),
    tokensOut: sumObserved((event) => event.tokensOut),
    cacheReadTokens: sumObserved((event) => event.cacheReadTokens),
    cacheCreationTokens: sumObserved((event) => event.cacheCreationTokens),
    cacheCreation5mTokens: sumObserved((event) => event.cacheCreation5mTokens),
    cacheCreation1hTokens: sumObserved((event) => event.cacheCreation1hTokens),
    durationApiMs: results.reduce((s, e) => s + (e.durationApiMs ?? 0), 0) || undefined,
    durationMs: results.reduce((s, e) => s + (e.durationMs ?? 0), 0) || undefined,
    contextTokens: contextSource?.contextTokens,
    modelUsage: contextSource?.modelUsage?.some((m) => m.contextWindow) ? (modelUsage ?? contextSource.modelUsage) : modelUsage
  }
}

export function aggregateSegmentsRich(turns: Turn[]): SegmentReport {
  type TurnCtx = { kind: RichSegment['kind']; name: string }
  let activeSkill: string | null = null
  let skillSwitches = 0
  let subagents = 0
  const turnCtx: TurnCtx[] = turns.map((t) => {
    const items = t.items.filter((e) => e.stage !== 'tool_result')
    const skillEv = items.find((e) => e.kind === 'skill')
    if (skillEv) {
      const nm = skillEv.name ?? 'skill'
      if (nm !== activeSkill) skillSwitches++
      activeSkill = nm
    }
    const agentEv = items.find((e) => e.kind === 'agent')
    if (agentEv) {
      subagents++
      return { kind: 'subagent', name: agentEv.name ?? 'subagent' }
    }
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

  const totalApiMs = turns.reduce((s, t) => s + resultsOf(t).reduce((sum, r) => sum + (r.durationApiMs ?? 0), 0), 0)
  const totalCost = turns.reduce((s, t) => s + resultsOf(t).reduce((sum, r) => sum + (r.costUsd ?? 0), 0), 0)
  const totalTokens = turns.reduce((s, t) => s + resultsOf(t).reduce((sum, r) => sum + resultTokenTotal(r), 0), 0)

  const actLabel = (e: TraceEvent): SegAct => {
    if (e.kind === 'agent') return { label: e.name ?? 'Task', count: 0, agent: true }
    if (e.isMcp) return { label: `mcp:${e.mcpServer ?? '?'}`, count: 0, mcp: true }
    if (e.tool === 'Read') return { label: 'R', op: 'r', count: 0 }
    if (e.tool === 'Write') return { label: 'W', op: 'w', count: 0 }
    if (e.tool === 'Edit' || e.tool === 'MultiEdit' || e.tool === 'NotebookEdit') return { label: 'E', op: 'e', count: 0 }
    return { label: e.tool ?? e.kind, count: 0 }
  }

  const segments: RichSegment[] = groups.map((g) => {
    const segTurns = g.idx.map((i) => turns[i])
    const items = segTurns.flatMap((t) => t.items).filter((e) => e.stage !== 'tool_result')
    const cost = segTurns.reduce((s, t) => s + resultsOf(t).reduce((sum, r) => sum + (r.costUsd ?? 0), 0), 0)
    const totalTokensForSegment = segTurns.reduce((s, t) => s + resultsOf(t).reduce((sum, r) => sum + resultTokenTotal(r), 0), 0)
    const apiMs = segTurns.reduce((s, t) => s + resultsOf(t).reduce((sum, r) => sum + (r.durationApiMs ?? 0), 0), 0)
    const actMap = new Map<string, SegAct>()
    let reads = 0
    let writes = 0
    let edits = 0
    let tools = 0
    let dangers = 0
    const readFiles = new Map<string, number>()
    const filesSet = new Set<string>()
    for (const e of items) {
      if (e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent') {
        tools++
        const a = actLabel(e)
        const cur = actMap.get(a.label) ?? a
        cur.count++
        actMap.set(a.label, cur)
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
      apiMs,
      tools,
      reads,
      writes,
      edits,
      errors,
      dangers,
      pct: totalApiMs > 0 ? (apiMs / totalApiMs) * 100 : 0,
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
  return { segments, sessionTurns: turns.length, totalApiMs, totalCost, totalTokens, skillSwitches, subagents }
}

// 解析用户消息：claude code 把斜杠命令 /cmd args 存成 <command-name>/<command-args> 标签
// （历史会话回放时尤其常见），把它抽成干净命令 + 去标签后的正文（skill 注入等）。
export interface ParsedUserMsg {
  command?: string // 如 "/workflow-orchestrator 12345678"
  body: string // 去掉 command 标签后的正文
  injectedSkill?: string // skill 触发时 claude code 注入的 SKILL.md（开头 "Base directory for this skill:"），值=skill 名
}
export function parseUserMessage(text: string): ParsedUserMsg {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim()
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
  const body = text.replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g, '').trim()
  const command = name ? (args ? `${name} ${args}` : name) : undefined
  // skill 注入：不是用户真实输入，是 claude code 把 SKILL.md 塞成 user 消息（路径最后一段=skill 名）
  const inject = !command ? body.match(/^Base directory for this skill:\s*(.+?)\s*$/m) : null
  const injectedSkill = inject ? (inject[1].split('/').filter(Boolean).pop() ?? undefined) : undefined
  return { command, body, injectedSkill }
}

export function aggregateFiles(items: TraceEvent[]): { structured: FileRow[]; bash: string[] } {
  const m = new Map<string, FileRow>()
  const bash = new Set<string>()
  for (const e of items) {
    if (e.stage === 'tool_result') continue
    if (e.fileOp && e.filePath) {
      let r = m.get(e.filePath)
      if (!r) {
        r = { path: e.filePath, read: 0, write: 0, edit: 0 }
        m.set(e.filePath, r)
      }
      if (e.fileOp === 'read') r.read++
      else if (e.fileOp === 'write') r.write++
      else r.edit++
    } else if (e.tool === 'Bash') {
      const inp = e.input as Record<string, unknown> | undefined
      if (typeof inp?.command === 'string') bashFiles(inp.command).forEach((f) => bash.add(f))
    }
  }
  for (const k of m.keys()) bash.delete(k)
  return { structured: [...m.values()], bash: [...bash] }
}

export function fileBadge(f: FileRow): string {
  return f.write > 0 ? 'W' : f.edit > 0 ? 'E' : 'R'
}

export type AttributionMethod = 'direct' | 'turn_allocated' | 'heuristic' | 'unattributed'
export type BillingSignalSeverity = 'info' | 'warn' | 'bad'

export interface BillingTurnRow {
  turnNo: number
  runId: string
  label: string
  cost: number
  costKnown: boolean
  tokensTotal: number
  tokenKnown: boolean
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
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
  cost: number
  costKnown: boolean
  totalTokens: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextWindow?: number
  costSource: string
  confidence: string
}

export interface BillingEvidenceRow {
  kind: 'skill' | 'tool' | 'mcp' | 'hook' | 'agent'
  name: string
  count: number
  relatedCost: number
  relatedTokens: number
  relatedTurns: number
  costKnownTurns: number
  costMissingTurns: number
  tokenKnownTurns: number
  tokenMissingTurns: number
  attributionMethod: AttributionMethod
  firstEvent?: TraceEvent
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
  totalCost: number
  totalTokens: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
  apiMs: number
  resultTurns: number
  knownCostResultCount: number
  missingCostResultCount: number
  knownTokenResultCount: number
  missingTokenResultCount: number
  directRunCoveragePct: number
  modelCostCoveragePct: number
  tokenCoveragePct: number
  modelTokenCoveragePct: number
  workflowDirectCoveragePct: number
  workflowUnattributedPct: number
  workflowUnattributedCost: number
  workflowUnattributedTokens: number
  topCostTurns: BillingTurnRow[]
  topTokenTurns: BillingTurnRow[]
  allTurnRows: BillingTurnRow[]
  models: BillingModelRow[]
  evidence: BillingEvidenceRow[]
  signals: BillingSignal[]
}

function costSourceName(source: string | undefined, confidence: string | undefined): string {
  const s = source ?? 'sdk_estimate'
  const c = confidence ?? 'estimated'
  if (s === 'sdk_estimate') return c === 'estimated' ? 'Claude SDK 估算' : 'Claude SDK'
  if (s === 'gateway_reported') return '网关上报'
  if (s === 'provider_bill') return '官方账单'
  if (s === 'provider_reported') return '供应商上报'
  if (s === 'official_telemetry') return '官方 telemetry'
  if (s === 'analytics_report') return '分析报告'
  if (s === 'price_table') return '历史价格字段'
  return s
}

function cleanTurnLabel(t: Turn, turnNo: number): string {
  const parsed = parseUserMessage(t.userText)
  const raw = parsed.command || parsed.body.split('\n').find((line) => line.trim()) || `turn ${turnNo}`
  return (maskSecrets(raw.replace(/\s+/g, ' ').trim()) ?? raw).slice(0, 96)
}

function safeReportLabel(name: string): string {
  return (maskSecrets(name.replace(/\s+/g, ' ').trim()) ?? name).slice(0, 96)
}

function modelCostSource(mu: ModelUsageRow): { costSource: string; confidence: string } {
  return {
    costSource: costSourceName(mu.costSource, mu.costConfidence),
    confidence: mu.costConfidence ?? (mu.costUsd != null ? 'estimated' : 'inferred')
  }
}

function eventNameForEvidence(e: TraceEvent): { kind: BillingEvidenceRow['kind']; name: string; method: AttributionMethod } | null {
  if (e.stage === 'tool_result') return null
  if (e.kind === 'skill') return { kind: 'skill', name: safeReportLabel(e.name ?? 'skill'), method: 'turn_allocated' }
  if (e.kind === 'agent') return { kind: 'agent', name: safeReportLabel(e.name ?? 'Task'), method: 'turn_allocated' }
  if (e.kind === 'hook') return { kind: 'hook', name: safeReportLabel(e.hookName ?? e.name ?? 'Hook'), method: 'heuristic' }
  if (e.kind === 'tool' && e.isMcp) return { kind: 'mcp', name: safeReportLabel(`mcp:${e.mcpServer ?? '?'}`), method: 'turn_allocated' }
  if (e.kind === 'tool') return { kind: 'tool', name: safeReportLabel(e.tool ?? e.stage), method: 'turn_allocated' }
  return null
}

function hiddenSpendCommand(e: TraceEvent): boolean {
  if (e.tool !== 'Bash') return false
  const input = e.input as Record<string, unknown> | undefined
  const cmd = typeof input?.command === 'string' ? input.command : ''
  return /\b(openai|anthropic|gemini|openrouter)\b|curl\s+https?:\/\/api\./i.test(cmd)
}

export function attributionMethodLabel(method: AttributionMethod): string {
  if (method === 'direct') return '直接归因'
  if (method === 'turn_allocated') return '同轮关联'
  if (method === 'heuristic') return '弱关联'
  return '未归因'
}

export function attributionMethodHint(method: AttributionMethod): string {
  if (method === 'direct') return '这个对象本身带有用量字段。'
  if (method === 'turn_allocated') return '该对象出现在哪些 turn，就关联这些 turn 的总 token；多行会重复覆盖同一 turn，不能相加。'
  if (method === 'heuristic') return '按时间和 turn 邻近关系推断，只能作为弱线索，不代表 hook 自身消耗 token。'
  return '没有足够数据归因。'
}

export function evidenceCostBasisLabel(method: AttributionMethod): string {
  if (method === 'direct') return '直接 token'
  if (method === 'heuristic') return '相邻轮次 token'
  return '所在轮次 token'
}

export function fmtKnownCost(value: number, knownCount: number, missingCount = 0): string {
  if (knownCount === 0 && missingCount === 0) return '等待 result'
  if (knownCount === 0 && missingCount > 0) return '未捕获'
  return `$${value.toFixed(4)}${missingCount > 0 ? '+' : ''}`
}

export function fmtKnownTokens(value: number, knownCount: number, missingCount = 0): string {
  if (knownCount === 0 && missingCount === 0) return '等待 result'
  if (knownCount === 0 && missingCount > 0) return '未捕获'
  return `${fmtTok(value)} tok${missingCount > 0 ? '+' : ''}`
}

export function analyzeBilling(turns: Turn[]): BillingAnalysis {
  const all = turns.flatMap((t) => t.items)
  const results = turns.map(resultOf).filter((event): event is TraceEvent => event != null)

  const allTurnRows: BillingTurnRow[] = turns.map((t, i) => {
    const r = resultOf(t)
    const model = r?.modelUsage?.[0]
    const contextWindow = model?.contextWindow
    const contextTokens = r?.contextTokens
    const tokensTotal = resultTokenTotal(r)
    const tokenKnown = hasTokenUsage(r)
    const toolCount = t.items.filter(
      (e) => e.stage !== 'tool_result' && (e.kind === 'tool' || e.kind === 'skill' || e.kind === 'agent')
    ).length
    const errorCount = t.items.filter((e) => e.stage === 'tool_result' && e.isError).length
    return {
      turnNo: i + 1,
      runId: t.runId,
      label: cleanTurnLabel(t, i + 1),
      cost: r?.costUsd ?? 0,
      costKnown: r?.costUsd != null,
      tokensTotal,
      tokenKnown,
      tokensIn: r?.tokensIn ?? 0,
      tokensOut: r?.tokensOut ?? 0,
      cacheReadTokens: r?.cacheReadTokens ?? 0,
      cacheCreationTokens: r?.cacheCreationTokens ?? 0,
      contextTokens,
      contextWindow,
      contextPct: contextTokens && contextWindow ? Math.round((contextTokens / contextWindow) * 100) : undefined,
      model: model?.model,
      toolCount,
      errorCount,
      result: r
    }
  })

  const totalCost = results.reduce((s, e) => s + (e.costUsd ?? 0), 0)
  const knownCostResultCount = results.filter((e) => e.costUsd != null).length
  const missingCostResultCount = Math.max(0, results.length - knownCostResultCount)
  const tokensIn = results.reduce((s, e) => s + (e.tokensIn ?? 0), 0)
  const tokensOut = results.reduce((s, e) => s + (e.tokensOut ?? 0), 0)
  const cacheReadTokens = results.reduce((s, e) => s + (e.cacheReadTokens ?? 0), 0)
  const cacheCreationTokens = results.reduce((s, e) => s + (e.cacheCreationTokens ?? 0), 0)
  const totalTokens = usageTokenTotal(tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens)
  const knownTokenResultCount = results.filter(hasTokenUsage).length
  const missingTokenResultCount = Math.max(0, results.length - knownTokenResultCount)
  const apiMs = results.reduce((s, e) => s + (e.durationApiMs ?? 0), 0)

  const modelMap = new Map<string, BillingModelRow>()
  for (const r of results) {
    for (const mu of r.modelUsage ?? []) {
      const source = modelCostSource(mu)
      const prev =
        modelMap.get(mu.model) ??
        ({
          model: mu.model,
          cost: 0,
          costKnown: true,
          totalTokens: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: mu.contextWindow,
          costSource: source.costSource,
          confidence: source.confidence
        } satisfies BillingModelRow)
      prev.cost += mu.costUsd ?? 0
      prev.costKnown = prev.costKnown && mu.costUsd != null
      prev.tokensIn += mu.inputTokens ?? 0
      prev.tokensOut += mu.outputTokens ?? 0
      prev.cacheReadTokens += mu.cacheReadTokens ?? 0
      prev.cacheCreationTokens += mu.cacheCreationTokens ?? 0
      prev.totalTokens = usageTokenTotal(prev.tokensIn, prev.tokensOut, prev.cacheReadTokens, prev.cacheCreationTokens)
      prev.contextWindow = prev.contextWindow ?? mu.contextWindow
      modelMap.set(mu.model, prev)
    }
  }
  const models = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut))
  const modelCost = models.reduce((s, m) => s + m.cost, 0)
  const modelTokens = models.reduce((s, m) => s + m.totalTokens, 0)

  type EvidenceDraft = Omit<BillingEvidenceRow, 'relatedTurns'> & { turnIds: Set<string> }
  const evidenceMap = new Map<string, EvidenceDraft>()
  for (const [i, t] of turns.entries()) {
    const turnCost = allTurnRows[i]?.cost ?? 0
    const turnTokens = allTurnRows[i]?.tokensTotal ?? 0
    for (const e of t.items) {
      const meta = eventNameForEvidence(e)
      if (!meta) continue
      const key = `${meta.kind}\u0000${meta.name}`
      let row = evidenceMap.get(key)
      if (!row) {
        row = {
          kind: meta.kind,
          name: meta.name,
          count: 0,
          relatedCost: 0,
          relatedTokens: 0,
          costKnownTurns: 0,
          costMissingTurns: 0,
          tokenKnownTurns: 0,
          tokenMissingTurns: 0,
          turnIds: new Set(),
          attributionMethod: meta.method,
          firstEvent: e
        }
        evidenceMap.set(key, row)
      }
      row.count++
      if (!row.turnIds.has(t.runId)) {
        row.turnIds.add(t.runId)
        if (allTurnRows[i]?.costKnown) {
          row.relatedCost += turnCost
          row.costKnownTurns++
        } else if (allTurnRows[i]?.result) {
          row.costMissingTurns++
        }
        if (allTurnRows[i]?.tokenKnown) {
          row.relatedTokens += turnTokens
          row.tokenKnownTurns++
        } else if (allTurnRows[i]?.result) {
          row.tokenMissingTurns++
        }
      }
    }
  }
  const evidence = [...evidenceMap.values()]
    .map(({ turnIds, ...row }) => ({ ...row, relatedTurns: turnIds.size }))
    .sort((a, b) => b.relatedTokens - a.relatedTokens || b.count - a.count || a.name.localeCompare(b.name))

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
        ? `TURN ${String(row.turnNo).padStart(2, '0')} · 较此前已捕获轮次均值 ${fmtTok(previousAverage)} ≥ 2× · 工具 ${row.toolCount} 次`
        : `TURN ${String(row.turnNo).padStart(2, '0')} · 总 Token ≥ 100.0k 规则阈值 · 工具 ${row.toolCount} 次 · 输入/输出 ${fmtTok(row.tokensIn + row.tokensOut)}`,
      action: '展开该 turn 的 model/cache/tool 证据，必要时拆任务',
      evidence: row.result
    })
  }

  const repeatInTurn = turns
    .map((t, i) => {
      const per = new Map<string, number>()
      for (const e of t.items) {
        if (e.stage === 'tool_result') continue
        if (e.kind !== 'tool' && !e.isMcp) continue
        const name = e.isMcp ? `mcp:${e.mcpServer ?? '?'}` : (e.tool ?? e.stage)
        per.set(name, (per.get(name) ?? 0) + 1)
      }
      const top = [...per.entries()].sort((a, b) => b[1] - a[1])[0]
      return top ? { turn: allTurnRows[i], name: top[0], count: top[1] } : null
    })
    .filter((x): x is { turn: BillingTurnRow; name: string; count: number } => !!x && x.count >= 8)[0]
  if (repeatInTurn) {
    signals.push({
      severity: 'warn',
      title: `高频工具调用 ${repeatInTurn.name} ${repeatInTurn.count}×`,
      detail: `TURN ${String(repeatInTurn.turn.turnNo).padStart(2, '0')} · 单轮调用达到频次阈值（≥8）；频次本身不等同于循环`,
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

  const subagent = allTurnRows.find((r, i) => turns[i].items.some((e) => e.kind === 'agent') && (r.toolCount >= 20 || r.tokensTotal >= 100_000))
  if (subagent) {
    const subagentTokenText = subagent.result
      ? fmtKnownTokens(subagent.tokensTotal, subagent.tokenKnown ? 1 : 0, subagent.tokenKnown ? 0 : 1)
      : '等待 result'
    signals.push({
      severity: subagent.tokensTotal >= 250_000 || subagent.toolCount >= 40 ? 'bad' : 'warn',
      title: `子 agent 消耗 ${subagent.toolCount} 工具`,
      detail: `TURN ${String(subagent.turnNo).padStart(2, '0')} · ${subagentTokenText}`,
      action: '确认子 agent 是否仍在必要范围内',
      evidence: subagent.result
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
    totalCost,
    totalTokens,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    apiMs,
    resultTurns: results.length,
    knownCostResultCount,
    missingCostResultCount,
    knownTokenResultCount,
    missingTokenResultCount,
    directRunCoveragePct: results.length > 0 ? Math.round((knownCostResultCount / results.length) * 100) : 0,
    modelCostCoveragePct: totalCost > 0 ? Math.min(100, Math.round((modelCost / totalCost) * 100)) : knownCostResultCount > 0 ? 100 : 0,
    tokenCoveragePct: results.length > 0 ? Math.round((knownTokenResultCount / results.length) * 100) : 0,
    modelTokenCoveragePct: totalTokens > 0 ? Math.min(100, Math.round((modelTokens / totalTokens) * 100)) : knownTokenResultCount > 0 ? 100 : 0,
    workflowDirectCoveragePct: 0,
    workflowUnattributedPct: totalTokens > 0 ? 100 : 0,
    workflowUnattributedCost: totalCost,
    workflowUnattributedTokens: totalTokens,
    topCostTurns: [...allTurnRows].filter((r) => r.costKnown && r.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 5),
    topTokenTurns: [...allTurnRows].filter((r) => r.tokenKnown && r.tokensTotal > 0).sort((a, b) => b.tokensTotal - a.tokensTotal).slice(0, 10),
    allTurnRows,
    models,
    evidence,
    signals
  }
}

// Billing Guardian P0：把本会话的 SDK/transcript token 和行动信号汇成可复制 Markdown。
// 工具/Skill/MCP/hook 没有独立 token 字段；报告只说明不可硬拆，不展示弱关联明细。
export function buildSessionReport(turns: Turn[], gitDiff: DiffFile[] = [], opts: { sessionId?: string | null } = {}): string {
  const billing = analyzeBilling(turns)
  const all = turns.flatMap((t) => t.items)
  const calls = aggregateCalls(all)
  const { structured } = aggregateFiles(all)
  const cov = fileWriteCoverage(all)
  const segs = aggregateSegments(all)
  const dangers = all.filter((e) => e.danger && e.stage !== 'tool_result')
  const toolErrors = all.filter((e) => e.stage === 'tool_result' && e.isError).length
  const touched = new Set(structured.map((f) => f.path))
  const diffUntouched = gitDiff.filter((d) => !touched.has(d.path))

  const L: string[] = ['# Session Token 用量报告']
  if (opts.sessionId) L.push(`- **sessionId**：${opts.sessionId}`)
  L.push(`- **计量口径**：${billing.sourceLabel}；${billing.officialBillLabel}`)
  L.push(
    `- **本会话已知用量**：${fmtKnownTokens(billing.totalTokens, billing.knownTokenResultCount, billing.missingTokenResultCount)} · 输入/输出 ${fmtTok(billing.tokensIn)}→${fmtTok(billing.tokensOut)} · 缓存读/写 ${fmtTok(billing.cacheReadTokens)}/${fmtTok(billing.cacheCreationTokens)} · ${calls.toolTotal} 次工具/Skill/MCP 调用`
  )
  L.push(
    `- **数据完整性**：轮次覆盖 ${billing.tokenCoveragePct}%；模型明细覆盖 ${billing.modelTokenCoveragePct}%；工具拆分：暂无独立 token 字段，不把整轮 token 分摊给具体工具`
  )
  const maxCtx = [...billing.allTurnRows].filter((r) => r.contextPct != null).sort((a, b) => (b.contextPct ?? 0) - (a.contextPct ?? 0))[0]
  if (maxCtx?.contextPct != null) L.push(`- **最大上下文**：TURN ${String(maxCtx.turnNo).padStart(2, '0')} · ${maxCtx.contextPct}%`)
  if (billing.models.length)
    L.push(
      `- **模型用量**：${billing.models
        .map((m) => `${m.model} ${fmtTok(m.totalTokens)} tok · 输入/输出 ${fmtTok(m.tokensIn)}→${fmtTok(m.tokensOut)} · 缓存 ${fmtTok(m.cacheReadTokens)}/${fmtTok(m.cacheCreationTokens)}`)
        .join(' · ')}`
    )
  if (billing.topTokenTurns.length) {
    L.push('', '## 高 Token 轮次')
    for (const t of billing.topTokenTurns.slice(0, 10)) {
      L.push(
        `- TURN ${String(t.turnNo).padStart(2, '0')}：${fmtKnownTokens(t.tokensTotal, t.tokenKnown ? 1 : 0)} · 输入/输出 ${fmtTok(t.tokensIn + t.tokensOut)} · 缓存 ${fmtTok(t.cacheReadTokens + t.cacheCreationTokens)} · ${t.toolCount} 工具 · ${t.label}`
      )
    }
  }
  if (billing.signals.length) {
    L.push('', '## 行动信号')
    for (const s of billing.signals) L.push(`- [${s.severity}] ${s.title}：${s.detail}；${s.action}`)
  }
  if (calls.tools.length) L.push(`- **工具**：${calls.tools.map((t) => `${safeReportLabel(t.name)}×${t.count}`).join(' · ')}`)
  if (calls.skills.length) L.push(`- **Skill**：${calls.skills.map((s) => `${safeReportLabel(s.name)}×${s.count}`).join(' · ')}`)
  if (calls.agents.length) L.push(`- **子 Agent**：${calls.agents.map((a) => `${safeReportLabel(a.name)}×${a.count}`).join(' · ')}`)
  if (calls.mcp.length) L.push(`- **MCP**：${calls.mcp.map((g) => `${safeReportLabel(g.server)}×${g.total}`).join(' · ')}`)
  if (segs.some((s) => s.skill !== '（无 skill）'))
    L.push(`- **段落(按 skill)**：${segs.map((s) => `${s.skill} ${s.tools} 工具`).join(' · ')}`)
  if (cov.written > 0)
    L.push(`- **文件（结构化工具）**：改 ${cov.written}（先读 ${cov.readBefore}/${cov.written}${cov.blind.length ? `，首写前未读 ${cov.blind.length}` : ''}）`)
  if (gitDiff.length)
    L.push(`- **git diff**：${gitDiff.length} 文件${diffUntouched.length ? `（${diffUntouched.length} 未经工具标记）` : ''}`)
  if (dangers.length)
    L.push(
      `- **危险审计**：${dangers.map((e) => `[${e.danger!.level === 'danger' ? '高危' : '可疑'}] ${e.danger!.reason}`).join(' · ')}`
    )

  // 从真实数据派生的优化提示（有就列，没有不编）
  const hints: string[] = []
  if (cov.blind.length) hints.push(`${cov.blind.length} 个文件首次写入前未读（先写风险）：${cov.blind.map(basename).join('、')}`)
  if (toolErrors > 0) hints.push(`工具失败 ${toolErrors} 次，检查报错卡片`)
  if (diffUntouched.length) hints.push(`${diffUntouched.length} 个文件被改但不在工具足迹里（Bash/MCP 盲区）`)
  if (dangers.length) hints.push(`${dangers.length} 处危险操作（审计放行，未拦截）`)
  if (hints.length) {
    L.push('', '## 提示（本会话数据）')
    for (const h of hints) L.push(`- ${h}`)
  }
  return L.join('\n')
}

// 性能：把一批 onTrace 事件一次性合并进 turns（替代每事件一次 setState）。FIFO 保序、按 id 去重、
// 连续 text_delta 合并进上一条——语义与逐事件版完全一致，只是批量。clone-on-write 只复制变动的 turn。
export function applyTraceBatch(prev: Turn[], events: TraceEvent[], cleared: Set<string>): Turn[] {
  let next = prev
  let mutated = false
  for (const ev of events) {
    if (cleared.has(ev.runId)) continue // New chat 清掉的旧 run，丢弃残余在途事件
    const i = next.findIndex((t) => t.runId === ev.runId)
    if (i === -1) {
      if (!mutated) {
        next = [...next]
        mutated = true
      }
      next.push({ runId: ev.runId, userText: '', items: [ev], done: false })
      continue
    }
    const items = next[i].items
    if (items.some((e) => e.id === ev.id)) continue // 去重
    const last = items[items.length - 1]
    const merged =
      ev.stage === 'text_delta' && last?.stage === 'text_delta'
        ? [...items.slice(0, -1), { ...last, text: (last.text ?? '') + (ev.text ?? '') }]
        : [...items, ev]
    if (!mutated) {
      next = [...next]
      mutated = true
    }
    next[i] = { ...next[i], items: merged }
  }
  return next
}
