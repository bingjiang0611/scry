// renderer 共享的纯逻辑：常量 / 视图类型 / 格式化与投影 helper。无 React 依赖，给各组件复用。
import {
  maskSecrets,
  mcpCallsForEvent,
  type TraceEvent,
  type DiffFile,
  type HookConfiguredCommand,
  type McpLiveStatus,
  type ModelUsageRow
} from '@shared/trace'
import type { AgentInputAttachment } from '@shared/runtime'
import { logicalCallEventsForTurn } from '@shared/logical-calls'
import { inferredReadPaths } from './file-evidence'
export { logicalCallEventsForTurn }
export { bashReadFiles } from './file-evidence'

// 视觉升级：值改成 Icon 名（蓝本 SVG 图标），消费处用 <Icon name={...}>。
export const AGENT_ICON: Record<string, string> = {
  claude: 'cube',
  codex: 'square',
  cursor: 'square',
  gemini: 'square',
  qoder: 'square'
}

export interface FileRow {
  path: string
  read: number
  inferredRead: number
  write: number
  edit: number
}

// P2 Files（RFC §8.4）：写/改文件的「读覆盖」——第一次写入前有没有读取证据。
// tool_result 会继承 fileOp/filePath，必须排除；写后补读不反向洗掉盲改风险。
export interface FileCoverage {
  written: number // 写或改过的文件数
  readBefore: number // 第一次写或改之前已读过的文件数
  inferredReadBefore: number // readBefore 中仅由 Bash 只读命令推断的文件数
  blind: string[] // 第一次写或改之前没有读取证据的文件路径（仍可能存在未识别的间接读取）
}

export function fileWriteCoverage(items: TraceEvent[]): FileCoverage {
  const candidatePaths = [...new Set(items.flatMap((event) => event.filePath ? [event.filePath] : []))]
  const exactRead = new Set<string>()
  const inferredRead = new Set<string>()
  const written = new Set<string>()
  const covered = new Set<string>()
  const inferredCovered = new Set<string>()
  const pending = new Map<string, TraceEvent[]>()
  const applyCompleted = (event: TraceEvent): void => {
    if (event.fileOp && event.filePath) {
      if (event.fileOp === 'read') {
        exactRead.add(event.filePath)
      } else if (!written.has(event.filePath)) {
        written.add(event.filePath)
        if (exactRead.has(event.filePath) || inferredRead.has(event.filePath)) {
          covered.add(event.filePath)
          if (!exactRead.has(event.filePath)) inferredCovered.add(event.filePath)
        }
      }
    }
    for (const path of inferredReadPaths(event, candidatePaths)) inferredRead.add(path)
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
    const hasFileEvidence =
      !!(event.fileOp && event.filePath) ||
      inferredReadPaths(event, candidatePaths).length > 0
    if (!hasFileEvidence) continue
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
  return {
    written: written.size,
    readBefore: covered.size,
    inferredReadBefore: inferredCovered.size,
    blind
  }
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

type TokenCacheAccounting = 'separate' | 'input_includes_cache'

function tokenCacheAccounting(e: Pick<TraceEvent, 'providerId' | 'runtimeProvider' | 'billingProvider'> | undefined): TokenCacheAccounting {
  if (
    e?.providerId === 'codex' ||
    e?.runtimeProvider === 'codex_cli' ||
    e?.billingProvider === 'codex' ||
    e?.billingProvider === 'openai'
  ) {
    return 'input_includes_cache'
  }
  return 'separate'
}

function usageTokenTotal(
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheCreation = 0,
  accounting: TokenCacheAccounting = 'separate'
): number {
  return input + output + (accounting === 'separate' ? cacheRead + cacheCreation : 0)
}

export function resultTokenTotal(e: TraceEvent | undefined): number {
  return usageTokenTotal(
    e?.tokensIn ?? 0,
    e?.tokensOut ?? 0,
    e?.cacheReadTokens ?? 0,
    e?.cacheCreationTokens ?? 0,
    tokenCacheAccounting(e)
  )
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
  ordinaryToolTotal: number
  skillTotal: number
  agentTotal: number
  mcpTotal: number
  totalCalls: number // 四类逻辑调用之和
  toolTotal: number // 兼容旧调用方：等于 totalCalls；新 UI 不应把它标成“工具”
}

export function aggregateCalls(items: TraceEvent[]): CallBreakdown {
  const tools = new Map<string, number>()
  const skills = new Map<string, number>()
  const agents = new Map<string, number>()
  const mcpMap = new Map<string, McpGroup>()
  for (const e of items) {
    if (e.stage === 'tool_result') continue // 工具结果不是一次调用，跳过
    if (e.kind === 'skill') {
      const n = e.name ?? 'skill'
      skills.set(n, (skills.get(n) ?? 0) + 1)
    } else if (e.kind === 'agent') {
      const n = e.name ?? 'agent'
      agents.set(n, (agents.get(n) ?? 0) + 1)
    } else if (e.kind === 'tool' && e.isMcp) {
      const refs = mcpCallsForEvent(e)
      for (const ref of refs) {
        let g = mcpMap.get(ref.server)
        if (!g) {
          g = { server: ref.server, total: 0, actions: [] }
          mcpMap.set(ref.server, g)
        }
        g.total++
        const a = g.actions.find((x) => x.tool === ref.tool)
        if (a) a.count++
        else g.actions.push({ action: ref.action, tool: ref.tool, count: 1 })
      }
    } else if (e.kind === 'tool') {
      const n = e.tool ?? e.stage
      tools.set(n, (tools.get(n) ?? 0) + 1)
    }
  }
  const toRows = (m: Map<string, number>): CallCount[] =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const mcp = [...mcpMap.values()].sort((a, b) => b.total - a.total)
  for (const g of mcp) g.actions.sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
  const ordinaryToolTotal = [...tools.values()].reduce((sum, count) => sum + count, 0)
  const skillTotal = [...skills.values()].reduce((sum, count) => sum + count, 0)
  const agentTotal = [...agents.values()].reduce((sum, count) => sum + count, 0)
  const mcpTotal = mcp.reduce((sum, group) => sum + group.total, 0)
  const totalCalls = ordinaryToolTotal + skillTotal + agentTotal + mcpTotal
  return {
    tools: toRows(tools),
    skills: toRows(skills),
    agents: toRows(agents),
    mcp,
    ordinaryToolTotal,
    skillTotal,
    agentTotal,
    mcpTotal,
    totalCalls,
    toolTotal: totalCalls
  }
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
  instances: HookInstanceRow[]
}

export interface HookInstanceRow {
  key: string
  hookId?: string
  command?: string
  source?: HookConfiguredCommand['source']
  sourcePath?: string
  configuredCommands: HookConfiguredCommand[]
  outcome?: string
  durationMs?: number
  isError: boolean
  last: TraceEvent
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
  triggerRuns: number | null
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

const HOOK_LIFECYCLE = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'TeammateIdle',
  'TaskCompleted',
  'SessionEnd'
] as const

const HOOK_LIFECYCLE_RANK = new Map<string, number>(
  HOOK_LIFECYCLE.map((event, index) => [event, index])
)

function hookLifecycleRank(event: string): number {
  const normalized = event.split(':', 1)[0]
  if (normalized === 'tool.execute.before') return HOOK_LIFECYCLE_RANK.get('PreToolUse')!
  if (normalized === 'tool.execute.after') return HOOK_LIFECYCLE_RANK.get('PostToolUse')!
  if (normalized === 'session.start') return HOOK_LIFECYCLE_RANK.get('SessionStart')!
  if (normalized === 'session.stop' || normalized === 'session.idle') return HOOK_LIFECYCLE_RANK.get('Stop')!
  return HOOK_LIFECYCLE_RANK.get(normalized) ?? HOOK_LIFECYCLE.length
}

function hookGroupFirstTimestamp(group: HookGroup): number {
  let first = Number.POSITIVE_INFINITY
  for (const script of group.scripts) {
    for (const instance of script.instances) {
      const timestamp = Date.parse(instance.last.ts)
      if (Number.isFinite(timestamp)) first = Math.min(first, timestamp)
    }
  }
  return first
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
  const expectedMarker = command.match(/--expected-marker(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s'"]+))/)
  const marker = expectedMarker?.[1] ?? expectedMarker?.[2] ?? expectedMarker?.[3]
  if (marker) return basename(cleanCommandToken(marker))
  const nestedScript = command.match(
    /(?:^|[\s"'`;])([^\s"'`;]*\.(?:py|sh|mjs|cjs|js|ts))(?=$|[\s"'`;])/i
  )?.[1]
  if (nestedScript) return basename(cleanCommandToken(nestedScript))
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

type HookScriptDraft = Omit<HookScriptRow, 'logicalRuns' | 'pending' | 'instances'> & {
  pendingKeys: Set<string>
  responseKeys: Set<string>
  instanceMap: Map<string, HookInstanceRow>
}

type HookGroupDraft = Omit<HookGroup, 'logicalRuns' | 'responses' | 'pending' | 'triggerRuns' | 'scripts'> & {
  scripts: Map<string, HookScriptDraft>
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function hookSource(value: unknown): HookConfiguredCommand['source'] | undefined {
  return value === 'user' || value === 'project' || value === 'local' || value === 'plugin' ? value : undefined
}

function mergedConfiguredCommands(
  previous: HookConfiguredCommand[],
  current: HookConfiguredCommand[] | undefined
): HookConfiguredCommand[] {
  const seen = new Set<string>()
  return [...previous, ...(current ?? [])].filter((candidate) => {
    const key = `${candidate.source}\0${candidate.sourcePath}\0${candidate.command}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

function hookRunIdentity(event: TraceEvent): string {
  return `${event.runId}\u0000${event.hookId ?? event.id}`
}

function triggerRunsForHook(items: TraceEvent[], event: string, trigger: string): number | null {
  const subject = hookTriggerSubject(event, trigger)
  if (!subject || subject === trigger) return null
  const calls = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'skill' && item.kind !== 'agent') continue
    if (item.stage === 'tool_result' || (item.tool ?? item.name) !== subject) continue
    calls.add(item.toolUseId ?? item.id)
  }
  return calls.size > 0 ? calls.size : null
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
    const runKey = `${event}\u0000${trigger}\u0000${hookRunIdentity(e)}`
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
    const runCommands = e.hookId
      ? commandsByRun.get(`${event}\u0000${trigger}\u0000${hookRunIdentity(e)}`)
      : undefined
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
        responseKeys: new Set(),
        instanceMap: new Map()
      }
      group.scripts.set(scriptKey, script)
    }

    const instanceKey = hookRunIdentity(e)
    const input = e.input as Record<string, unknown> | undefined
    const previousInstance = script.instanceMap.get(instanceKey)
    script.instanceMap.set(instanceKey, {
      key: instanceKey,
      hookId: e.hookId ?? previousInstance?.hookId,
      command: command ?? previousInstance?.command,
      source: hookSource(input?.source) ?? previousInstance?.source,
      sourcePath: stringField(input?.sourcePath) ?? previousInstance?.sourcePath,
      configuredCommands: mergedConfiguredCommands(
        previousInstance?.configuredCommands ?? [],
        e.hookConfiguredCommands
      ),
      outcome: e.hookOutcome ?? previousInstance?.outcome,
      durationMs: e.durationMs ?? previousInstance?.durationMs,
      isError: previousInstance?.isError === true || e.isError === true || e.hookOutcome === 'error' || e.hookOutcome === 'failure',
      last: e
    })

    group.rawEvents++
    script.rawEvents++
    if (e.stage === 'hook_response') {
      const responseKey = hookRunIdentity(e)
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
      script.pendingKeys.add(hookRunIdentity(e))
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
        const instances = [...s.instanceMap.values()].sort(
          (a, b) => Date.parse(a.last.ts) - Date.parse(b.last.ts) || a.key.localeCompare(b.key)
        )
        const { pendingKeys: _pendingKeys, responseKeys: _responseKeys, instanceMap: _instanceMap, ...row } = s
        return { ...row, responses, pending, logicalRuns, instances }
      })
      .sort((a, b) => b.logicalRuns - a.logicalRuns || b.rawEvents - a.rawEvents || a.label.localeCompare(b.label))
    const responses = scripts.reduce((sum, s) => sum + s.responses, 0)
    const pending = scripts.reduce((sum, s) => sum + s.pending, 0)
    const logicalRuns = responses + pending
    const triggerRuns = triggerRunsForHook(items, g.event, g.trigger)
    return {
      ...g,
      toolCalls: triggerRuns ?? 0,
      triggerRuns,
      scripts,
      responses,
      pending,
      logicalRuns
    }
  })

  finalized.sort(
    (a, b) =>
      hookLifecycleRank(a.event) - hookLifecycleRank(b.event) ||
      hookGroupFirstTimestamp(a) - hookGroupFirstTimestamp(b) ||
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
  totalTokens: number
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

export function resultOf(t: Turn | Pick<Turn, 'items'>): TraceEvent | undefined {
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
    const items = logicalCallEventsForTurn(t.items)
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
  const totalTokens = turnResults.reduce((sum, result) => sum + (result ? resultTokenTotal(result) : 0), 0)

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
    const items = segTurns.flatMap((t) => logicalCallEventsForTurn(t.items))
    const segmentResults = segTurns.map((turn) => resultOf(turn))
    const cost = segmentResults.reduce((sum, result) => sum + (result?.costUsd ?? 0), 0)
    const totalTokensForSegment = segmentResults.reduce((sum, result) => sum + (result ? resultTokenTotal(result) : 0), 0)
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
  const failedToolUseIds = new Set(
    items
      .filter((event) => event.stage === 'tool_result' && event.isError && event.toolUseId)
      .map((event) => event.toolUseId as string)
  )
  for (const e of items) {
    if (e.stage === 'tool_result') continue
    if (e.fileOp && e.filePath) {
      let r = m.get(e.filePath)
      if (!r) {
        r = { path: e.filePath, read: 0, inferredRead: 0, write: 0, edit: 0 }
        m.set(e.filePath, r)
      }
      if (e.fileOp === 'read') r.read++
      else if (e.fileOp === 'write') r.write++
      else r.edit++
    }
    if (e.tool === 'Bash') {
      const inp = e.input as Record<string, unknown> | undefined
      if (typeof inp?.command === 'string') bashFiles(inp.command).forEach((f) => bash.add(f))
    }
  }
  const candidates = [...m.keys()]
  for (const event of items) {
    if (event.stage === 'tool_result' || failedToolUseIds.has(event.toolUseId ?? '') || event.isError) continue
    for (const path of inferredReadPaths(event, candidates)) {
      let row = m.get(path)
      if (!row) {
        row = { path, read: 0, inferredRead: 0, write: 0, edit: 0 }
        m.set(path, row)
      }
      row.read++
      row.inferredRead++
    }
  }
  for (const k of m.keys()) bash.delete(k)
  return { structured: [...m.values()], bash: [...bash] }
}

export function fileBadge(f: FileRow): string {
  return f.write > 0 ? 'W' : f.edit > 0 ? 'E' : 'R'
}

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
  return (maskSecrets(raw.replace(/\s+/g, ' ').trim()) ?? raw).slice(0, 96)
}

function safeReportLabel(name: string): string {
  return (maskSecrets(name.replace(/\s+/g, ' ').trim()) ?? name).slice(0, 96)
}

function hiddenSpendCommand(e: TraceEvent): boolean {
  if (e.tool !== 'Bash') return false
  const input = e.input as Record<string, unknown> | undefined
  const cmd = typeof input?.command === 'string' ? input.command : ''
  return /\b(openai|anthropic|gemini|openrouter)\b|curl\s+https?:\/\/api\./i.test(cmd)
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
    const cacheAccounting = tokenCacheAccounting(r)
    const promptTokens =
      (r?.tokensIn ?? 0) +
      (cacheAccounting === 'separate' ? (r?.cacheReadTokens ?? 0) + (r?.cacheCreationTokens ?? 0) : 0)
    const toolCount = aggregateCalls(logicalCallEventsForTurn(t.items)).totalCalls
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
      model: model?.model,
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
        ? `TURN ${String(row.turnNo).padStart(2, '0')} · 较此前已捕获轮次均值 ${fmtTok(previousAverage)} ≥ 2× · 工具 ${row.toolCount} 次`
        : `TURN ${String(row.turnNo).padStart(2, '0')} · 总 Token ≥ 100.0k 规则阈值 · 工具 ${row.toolCount} 次 · 输入/输出 ${fmtTok(row.tokensIn + row.tokensOut)}`,
      action: '展开该 turn 的 model/cache/tool 证据，必要时拆任务',
      evidence: row.result
    })
  }

  const repeatInTurn = turns
    .map((t, i) => {
      const calls = aggregateCalls(logicalCallEventsForTurn(t.items))
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

  const subagent = turns
    .map((turn, index) => {
      const logical = logicalCallEventsForTurn(turn.items).filter(
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

// Billing Guardian P0：把本会话的 SDK/transcript token 和行动信号汇成可复制 Markdown。
// 工具/Skill/MCP/hook 没有独立 token 字段；报告只说明不可硬拆，不展示弱关联明细。
export function buildSessionReport(turns: Turn[], gitDiff: DiffFile[] = [], opts: { sessionId?: string | null } = {}): string {
  const billing = analyzeBilling(turns)
  const all = turns.flatMap((t) => t.items)
  const calls = aggregateCalls(turns.flatMap((turn) => logicalCallEventsForTurn(turn.items)))
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
    L.push(
      `- **文件（工具证据）**：改 ${cov.written}（先读 ${cov.readBefore}/${cov.written}${cov.inferredReadBefore ? `，其中 ${cov.inferredReadBefore} 个仅有 Bash 推断` : ''}${cov.blind.length ? `，无先读证据 ${cov.blind.length}` : ''}）`
    )
  if (gitDiff.length)
    L.push(`- **git diff**：${gitDiff.length} 文件${diffUntouched.length ? `（${diffUntouched.length} 未经工具标记）` : ''}`)
  if (dangers.length)
    L.push(
      `- **危险审计**：${dangers.map((e) => `[${e.danger!.level === 'danger' ? '高危' : '可疑'}] ${e.danger!.reason}`).join(' · ')}`
    )

  // 从真实数据派生的优化提示（有就列，没有不编）
  const hints: string[] = []
  if (cov.blind.length)
    hints.push(
      `${cov.blind.length} 个文件首次写入前无读取证据（可能仍有未识别的 Bash/MCP 读取）：${cov.blind.map(basename).join('、')}`
    )
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
    const existingIndex = items.findIndex((event) => event.id === ev.id)
    if (ev.kind === 'harness' && ev.stage === 'result_superseded') {
      if (existingIndex === -1) continue
      if (!mutated) {
        next = [...next]
        mutated = true
      }
      next[i] = { ...next[i], items: items.filter((_, index) => index !== existingIndex) }
      continue
    }
    if (existingIndex !== -1) {
      if (items[existingIndex] === ev) continue
      if (!mutated) {
        next = [...next]
        mutated = true
      }
      const updated = [...items]
      updated[existingIndex] = ev
      next[i] = { ...next[i], items: updated }
      continue
    }
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
