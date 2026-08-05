// 右栏纵览（蓝本视觉）：会话 verdict 卡 + context 占用 + top tools + 文件足迹 + git diff。
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  mcpCallsForEvent,
  type TraceEvent,
  type DbStats,
  type Diagnostics,
  type DiffFile,
  type HookConfiguredCommand,
  type McpLiveStatus
} from '@shared/trace'
import type { BillingGuardianState } from '@shared/billing'
import type { RuntimeProvider } from '@shared/runtime'
import { isOverviewToolErrorEvent } from '@shared/logical-calls'
import type { McpMeta } from '../env'
import { buildTurnTimingBreakdown, type TurnTimingBreakdown } from '../turn-timing'
import {
  aggregateHooks,
  aggregateCalls,
  aggregateFiles,
  aggregateSegments,
  analyzeBilling,
  basename,
  fileBadge,
  fmtKnownTokens,
  fileWriteCoverage,
  fmtTok,
  hookCancellationDetail,
  hookCommandLabel,
  logicalCallEventsForTurn,
  resultOf
} from '../format'
import type { BillingTurnRow, HookInstanceRow, HookScriptRow, Turn } from '../format'
import { Icon } from './primitives/Icon'
import { McpTrustPanel, type McpGuardReport } from './McpTrustPanel'
import { TurnTimingDetails } from './TurnTimingDetails'

// TOP TOOLS 排名：合并普通工具 + MCP（按 server 汇总），取前 6，配 mini-bar。
// 纯组件内聚合，不动 format.ts 的聚合函数（那些有测试，面板没有）。
function topToolColor(name: string): '' | 'read' | 'edit' | 'mcp' {
  if (name.startsWith('mcp:')) return 'mcp'
  if (name === 'Read') return 'read'
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit'
  return ''
}

function hookTone(h: { errors: number; responses: number; cancelled: number }): 'ok' | 'warn' | 'bad' {
  if (h.errors > 0) return 'bad'
  if (h.cancelled > 0) return 'warn'
  if (h.responses > 0) return 'ok'
  return 'warn'
}

function hookStatusText(h: { errors: number; responses: number; pending: number; cancelled: number; outcome?: string }): string {
  if (h.errors > 0) return 'error'
  if (h.cancelled > 0) return h.cancelled < h.responses ? '部分取消' : '已取消'
  if (h.responses > 0) return h.outcome ?? 'success'
  if (h.pending > 0) return 'started'
  return 'observed'
}

function hookBadgeText(h: {
  errors: number
  responses: number
  pending: number
  logicalRuns: number
  cancelled: number
  unsuccessful: TraceEvent[]
  outcome?: string
  exitCode?: number
  lastError?: TraceEvent
  lastCancelled?: TraceEvent
}): string {
  const cancellation = hookCancellationDetail(h.lastCancelled)
  const failed = Math.max(h.errors, h.unsuccessful.filter((event) => event.hookOutcome !== 'cancelled').length)
  const cancellationLabel =
    cancellation?.kind === 'timeout'
      ? '超时'
      : cancellation?.kind === 'suspected-timeout'
        ? '疑似超时'
        : '取消'
  const base =
    failed > 0
      ? `失败 ${failed}`
      : h.cancelled > 0
        ? `${h.cancelled < h.responses ? '取消' : cancellationLabel} ${h.cancelled}`
        : h.pending > 0
          ? `运行中 ${h.pending}`
          : h.responses > 0
            ? `成功 ${h.responses}`
            : hookStatusText(h)
  const errorInput = h.lastError?.input as Record<string, unknown> | undefined
  const errorExit =
    h.errors > 0 && h.lastError
      ? h.lastError.hookExitCode ?? (typeof errorInput?.exitCode === 'number' ? errorInput.exitCode : undefined)
      : undefined
  const code = h.errors > 0 ? errorExit ?? h.exitCode : undefined
  const exit = code != null ? ` · ${code}` : ''
  return `${base}${exit}`
}

function hookDetailText(h: HookScriptRow): string {
  const failed = Math.max(h.errors, h.unsuccessful.filter((event) => event.hookOutcome !== 'cancelled').length)
  const succeeded = Math.max(0, h.responses - h.cancelled - failed)
  const parts: string[] = []
  if (succeeded > 0) parts.push(`成功 ${succeeded}`)
  if (h.cancelled > 0) parts.push(`取消 ${h.cancelled}`)
  if (failed > 0) parts.push(`失败 ${failed}`)
  if (h.pending > 0) parts.push(`未结束 ${h.pending}`)
  if (h.progress > 0) parts.push(`进度通知 ${h.progress}`)
  return parts.join(' · ')
}

function hookCancellationTitle(h: HookScriptRow): string | undefined {
  const detail = hookCancellationDetail(h.lastCancelled)
  if (!detail) return undefined
  const label = detail.kind === 'timeout' ? '超时终止' : detail.kind === 'suspected-timeout' ? '疑似超时' : '已取消'
  const duration = formatTurnDuration(detail.durationMs)
  const timeout = formatTurnDuration(detail.timeoutMs)
  const limit = timeout
    ? ` / ${detail.timeoutSource === 'current-config' ? '当前配置上限' : '上限'} ${timeout}`
    : ''
  return `${label}${duration ? `：${duration}${limit}` : ''}；Hook 未正常完成，不代表对应工具调用也被取消。`
}

function hookFailureText(h: HookScriptRow): string | undefined {
  if (h.errors <= 0) return undefined
  return h.failureSummary ?? '最近失败事件未提供 stdout、stderr 或 content；只能看到 hook outcome / exit code。'
}

function hookConfigScopeLabel(source: HookConfiguredCommand['source']): string {
  return source === 'user' ? '用户' : source === 'project' ? '项目' : source === 'local' ? '本地' : '插件'
}

function uniqueConfiguredCommands(instances: HookInstanceRow[]): HookConfiguredCommand[] {
  const seen = new Set<string>()
  return instances
    .flatMap((instance) => instance.configuredCommands)
    .filter((candidate) => {
      const key = `${candidate.source}\0${candidate.sourcePath}\0${candidate.command}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function instanceConfiguredCommands(instance: HookInstanceRow): HookConfiguredCommand[] {
  if (instance.command) return []
  if (instance.sourcePath) {
    const samePath = instance.configuredCommands.filter((candidate) => candidate.sourcePath === instance.sourcePath)
    if (samePath.length > 0) return samePath
  }
  if (instance.source) {
    const sameSource = instance.configuredCommands.filter((candidate) => candidate.source === instance.source)
    if (sameSource.length > 0) return sameSource
  }
  return instance.configuredCommands
}

function hookInstanceLabel(instance: HookInstanceRow): string {
  if (instance.command) return hookCommandLabel(instance.command) ?? 'command'
  const candidates = instanceConfiguredCommands(instance)
  if (candidates.length === 1) return hookCommandLabel(candidates[0].command) ?? 'command'
  return '命令未逐实例上报'
}

function hookInstanceTone(instance: HookInstanceRow): 'ok' | 'warn' | 'bad' {
  if (instance.isError || instance.outcome === 'error' || instance.outcome === 'failure') return 'bad'
  if (instance.outcome === 'cancelled') return 'warn'
  if (instance.outcome === 'success') return 'ok'
  return 'warn'
}

function hookInstanceStatus(instance: HookInstanceRow): string {
  if (instance.isError || instance.outcome === 'error' || instance.outcome === 'failure') return '失败'
  if (instance.outcome === 'cancelled') return '取消'
  if (instance.outcome === 'success') return '成功'
  return '运行中'
}

interface HookInstanceDisplayGroup {
  key: string
  label: string
  status: string
  tone: 'ok' | 'warn' | 'bad'
  count: number
  averageDurationMs?: number
  timedCount: number
  sources: string[]
  last: TraceEvent
}

function hookInstanceSourceLabel(instance: HookInstanceRow): string {
  const sourcePath = instance.sourcePath ? basename(instance.sourcePath) : undefined
  return `${instance.source ? hookConfigScopeLabel(instance.source) : '来源未上报'}${sourcePath ? ` · ${sourcePath}` : ''}`
}

function groupHookInstances(instances: HookInstanceRow[]): HookInstanceDisplayGroup[] {
  const groups = new Map<
    string,
    Omit<HookInstanceDisplayGroup, 'averageDurationMs' | 'sources'> & {
      durationTotalMs: number
      sources: Set<string>
    }
  >()

  for (const instance of instances) {
    const label = hookInstanceLabel(instance)
    const status = hookInstanceStatus(instance)
    const key = `${label}\0${status}`
    const group = groups.get(key) ?? {
      key,
      label,
      status,
      tone: hookInstanceTone(instance),
      count: 0,
      timedCount: 0,
      durationTotalMs: 0,
      sources: new Set<string>(),
      last: instance.last
    }
    group.count++
    group.last = instance.last
    group.sources.add(hookInstanceSourceLabel(instance))
    if (instance.durationMs != null && Number.isFinite(instance.durationMs) && instance.durationMs >= 0) {
      group.durationTotalMs += instance.durationMs
      group.timedCount++
    }
    groups.set(key, group)
  }

  return [...groups.values()].map(({ durationTotalMs, sources, ...group }) => ({
    ...group,
    averageDurationMs: group.timedCount > 0 ? durationTotalMs / group.timedCount : undefined,
    sources: [...sources]
  }))
}

function hookDispatchLabel(command: string): string {
  return command.includes('global-hook-bridge.py') ? '桥接' : '直连'
}

interface LogicalHookRow {
  name: string
  deliveries: string[]
}

function logicalHookRows(commands: HookConfiguredCommand[], runtimeCommand?: string): LogicalHookRow[] {
  const rows = new Map<string, Set<string>>()
  const add = (name: string, delivery: string): void => {
    const deliveries = rows.get(name) ?? new Set<string>()
    deliveries.add(delivery)
    rows.set(name, deliveries)
  }
  if (runtimeCommand) add(hookCommandLabel(runtimeCommand) ?? 'command', '运行时')
  for (const candidate of commands) {
    add(
      hookCommandLabel(candidate.command) ?? 'command',
      `${hookConfigScopeLabel(candidate.source)}${candidate.pluginId ? ` · ${candidate.pluginId.split('@')[0]}` : ''}${candidate.source === 'plugin' ? '' : ` ${hookDispatchLabel(candidate.command)}`}`
    )
  }
  return [...rows.entries()]
    .map(([name, deliveries]) => ({ name, deliveries: [...deliveries] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function fmtShare(part: number, total: number): string | null {
  if (total <= 0 || part <= 0) return null
  return `${((part / total) * 100).toFixed(1).replace(/\.0$/, '')}%`
}

function highTokenTurnCacheHitRate(t: BillingTurnRow): string {
  return fmtShare(t.cacheReadTokens, t.promptTokens) ?? '—'
}

function highTokenTurnIoTokens(t: BillingTurnRow): string {
  const io = t.tokensIn + t.tokensOut
  return io > 0 ? fmtTok(io) : '—'
}

function highTokenTurnCacheTokens(t: BillingTurnRow): string {
  const cache = t.cacheReadTokens + t.cacheCreationTokens
  return cache > 0 ? fmtTok(cache) : '—'
}

function highTokenTurnContext(t: BillingTurnRow): string {
  return t.contextPct != null ? `${t.contextPct}%` : '—'
}

function highTokenTurnTitle(t: BillingTurnRow): string {
  const io = t.tokensIn + t.tokensOut
  const cache = t.cacheReadTokens + t.cacheCreationTokens
  const cacheHitRate = highTokenTurnCacheHitRate(t)
  const cacheShare = fmtShare(cache, t.tokensTotal)
  const ioShare = fmtShare(io, t.tokensTotal)
  const reason =
    cacheHitRate !== '—' && cache >= io * 2
      ? `缓存命中率 ${cacheHitRate}`
      : ioShare && io >= cache * 2
        ? `输入/输出占大头 ${ioShare}`
        : cacheHitRate !== '—' || cacheShare || ioShare
          ? `用量分布接近${cacheHitRate !== '—' ? `，缓存命中率 ${cacheHitRate}` : cacheShare ? `，缓存 ${cacheShare}` : ''}${ioShare ? `，输入/输出 ${ioShare}` : ''}`
          : '本轮用量偏高'
  return `${t.label} · ${fmtKnownTokens(t.tokensTotal, t.tokenKnown ? 1 : 0)} · ${reason} · 点跳到这轮对话`
}

type TurnCallKind = 'tool' | 'mcp' | 'skill' | 'agent'

interface TurnCallItem {
  name: string
  count: number
}

interface TurnCallRow {
  turnNo: number
  runId: string
  total: number
  firstEvent: TraceEvent | null
  result: TraceEvent | null
  groups: Record<TurnCallKind, TurnCallItem[]>
  userText: string
  timing: TurnTimingBreakdown
}

function formatTurnDuration(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`

  const totalSeconds = Math.round(ms / 1000)
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

const TURN_CALL_KIND_LABEL: Record<TurnCallKind, string> = {
  tool: '工具',
  mcp: 'MCP',
  skill: 'Skill',
  agent: '子Agent'
}

function addTurnCall(map: Map<string, number>, name: string): void {
  map.set(name, (map.get(name) ?? 0) + 1)
}

export function turnCallRowsFromMap(map: Map<string, number>, preserveCallOrder = false): TurnCallItem[] {
  const rows = [...map.entries()].map(([name, count]) => ({ name, count }))
  return preserveCallOrder ? rows : rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export { logicalCallEventsForTurn } from '../format'

function turnCallLabel(ev: TraceEvent, kind: TurnCallKind): string {
  if (kind === 'mcp') {
    const server = ev.mcpServer ?? 'mcp'
    return ev.mcpAction ? `${server}.${ev.mcpAction}` : server
  }
  if (kind === 'skill') return ev.name ?? 'Skill'
  if (kind === 'agent') return ev.name ?? 'Task'
  return ev.tool ?? ev.name ?? ev.stage
}

function turnCallKind(ev: TraceEvent): TurnCallKind | null {
  if (ev.stage === 'tool_result') return null
  if (ev.kind === 'skill') return 'skill'
  if (ev.kind === 'agent') return 'agent'
  if (ev.kind === 'tool' && ev.isMcp) return 'mcp'
  if (ev.kind === 'tool') return 'tool'
  return null
}

function turnUserPreview(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 48) ?? ''
}

function renderTurnCallGroup(
  kind: TurnCallKind,
  items: TurnCallItem[],
  toggle?: { expanded: boolean; onToggle: (ev: MouseEvent<HTMLButtonElement>) => void }
): ReactNode {
  if (items.length === 0) return null
  const visible = items.slice(0, 3)
  const hidden = items.slice(3).reduce((sum, item) => sum + item.count, 0)
  const total = items.reduce((sum, item) => sum + item.count, 0)
  const detailTitle = items.map((item) => `${item.name} ${item.count}×`).join('\n')
  if (toggle) {
    return (
      <button
        type="button"
        className={`turn-call-group turn-call-toggle ${kind}`}
        title={toggle.expanded ? `收起 ${TURN_CALL_KIND_LABEL[kind]} 明细` : `展开 ${TURN_CALL_KIND_LABEL[kind]} 明细`}
        aria-expanded={toggle.expanded}
        onClick={toggle.onToggle}
        onKeyDown={(ev) => ev.stopPropagation()}
      >
        <span className="turn-call-kind">{TURN_CALL_KIND_LABEL[kind]}</span>
        <span className="turn-call-count">{total}</span>
        <span className="turn-call-toggle-icon">
          <Icon name={toggle.expanded ? 'chevronDown' : 'chevronRight'} />
        </span>
      </button>
    )
  }
  return (
    <span className={`turn-call-group ${kind}`} title={detailTitle}>
      <span className="turn-call-kind">{TURN_CALL_KIND_LABEL[kind]}</span>
      {visible.map((item) => (
        <span className="turn-call-chip" key={`${kind}-${item.name}`}>
          {item.name}
          {item.count > 1 && <b>{item.count}</b>}
        </span>
      ))}
      {hidden > 0 && <span className="turn-call-more">+{hidden}</span>}
    </span>
  )
}

function renderTurnCallDetail(kind: TurnCallKind, items: TurnCallItem[]): ReactNode {
  if (items.length === 0) return null
  return (
    <div className={`turn-call-detail ${kind}`} onClick={(ev) => ev.stopPropagation()}>
      <div className="turn-call-detail-title">{TURN_CALL_KIND_LABEL[kind]} 明细</div>
      {items.map((item) => (
        <div className="turn-call-detail-row" key={`${kind}-${item.name}`} title={`${item.name} ${item.count}×`}>
          <span className="turn-call-detail-name">{item.name}</span>
          {item.count > 1 && <span className="turn-call-detail-count">{item.count}×</span>}
        </div>
      ))}
    </div>
  )
}

export function OverviewPanel({
  turns,
  sessionId = null,
  usage,
  runtimeProvider,
  mcpLive = [],
  mcps = [],
  mcpGuardReport = null,
  mcpGuardScanning = false,
  mcpRefreshing = false,
  gitDiff = [],
  busy = false,
  initialPanelTab = 'overview',
  onSelect,
  onOpenTurn,
  onMcpGuardReportChange,
  onMcpGuardScan,
  onMcpRefresh
}: {
  turns: Turn[]
  sessionId?: string | null
  selected: TraceEvent | null
  usage: { cost: number | null; tin: number | null; tout: number | null; turns: number } | null
  stats: DbStats | null
  billingState?: BillingGuardianState | null
  runtimeProvider?: RuntimeProvider
  mcpLive?: McpLiveStatus[]
  mcps?: McpMeta[]
  mcpGuardReport?: McpGuardReport | null
  mcpGuardScanning?: boolean
  mcpRefreshing?: boolean
  gitDiff?: DiffFile[]
  diag?: Diagnostics | null
  busy?: boolean
  initialPanelTab?: 'overview' | 'billing' | 'mcpTrust'
  onSelect: (ev: TraceEvent) => void
  onOpenTurn?: (runId: string, ev?: TraceEvent | null, target?: 'turn' | 'event') => void
  onMcpGuardReportChange?: (report: McpGuardReport) => void
  onMcpGuardScan?: () => Promise<McpGuardReport>
  onMcpRefresh?: () => Promise<void> | void
}) {
  const [filesFolded, setFilesFolded] = useState(false)
  const [panelTab, setPanelTab] = useState<'overview' | 'billing' | 'mcpTrust'>(initialPanelTab)
  const [overviewDataTab, setOverviewDataTab] = useState<'turns' | 'session'>('turns')
  const [expandedTurnCallGroups, setExpandedTurnCallGroups] = useState<Set<string>>(() => new Set())
  const dangerAuditRef = useRef<HTMLDivElement>(null)
  const all = useMemo(() => turns.flatMap((t) => t.items), [turns])
  const results = turns.map(resultOf).filter((event): event is TraceEvent => event != null)
  const sumObserved = (pick: (event: TraceEvent) => number | undefined): number | null => {
    const values = results.map(pick).filter((value): value is number => value != null)
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null
  }
  const tin = sumObserved((e) => e.tokensIn)
  const tout = sumObserved((e) => e.tokensOut)
  const totalTokens = tin == null && tout == null ? null : (tin ?? 0) + (tout ?? 0)
  // verdict foot 用全会话累计（和 cost/tokens pillar 一致，不混最后一轮）。
  const cacheR = sumObserved((e) => e.cacheReadTokens)
  const cacheW = sumObserved((e) => e.cacheCreationTokens)
  const apiMs = sumObserved((e) => e.durationApiMs)
  // Context% = 最近一轮的当前上下文占用（顶层 usage 完整 prompt）÷ 模型窗口。诚实的"现在装了多满"。
  const ctx = useMemo(() => {
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i]
      const modelRow = r.modelUsage?.find((row) => row.contextWindow != null && row.contextWindow > 0)
      const win = modelRow?.contextWindow
      const model = modelRow?.model
      if (r.contextTokens != null && win != null && win > 0)
        return { used: r.contextTokens, win, pct: Math.round((r.contextTokens / win) * 100), model }
    }
    return null
  }, [results])
  const logicalCallEvents = useMemo(() => turns.flatMap((turn) => logicalCallEventsForTurn(turn.items)), [turns])
  const calls = useMemo(() => aggregateCalls(logicalCallEvents), [logicalCallEvents])
  const turnCallRows = useMemo<TurnCallRow[]>(() => {
    return turns
      .map((turn, index) => {
        const logicalEvents = logicalCallEventsForTurn(turn.items)
        const result = resultOf(turn) ?? null
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
          firstEvent ??= ev
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
          timing: buildTurnTimingBreakdown(turn.items, logicalEvents, result ?? undefined)
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
      : fmtKnownTokens(billing.totalTokens, billing.knownTokenResultCount, billing.missingTokenResultCount)

  // verdict 状态（诚实）：高危→bad；运行中/有报错/可疑→warn；否则 ok。error 绝不显绿。
  const dangerHi = dangers.filter((e) => e.danger!.level === 'danger').length
  const toolErrors = all.filter(isOverviewToolErrorEvent).length
  const turnError = turns.some((t) => !!t.error)
  const hasError = toolErrors > 0 || turnError
  let vstate: 'ok' | 'warn' | 'bad' = 'ok'
  let judge = '完成'
  if (busy) {
    vstate = 'warn'
    judge = '运行中'
  } else if (dangerHi > 0) {
    vstate = 'bad'
    judge = `${dangerHi} 处高危操作`
  } else if (hasError) {
    vstate = 'warn'
    judge = toolErrors > 0 ? `完成 · ${toolErrors} 处工具报错` : '完成 · 有报错'
  } else if (dangers.length > 0) {
    vstate = 'warn'
    judge = `完成 · ${dangers.length} 处可疑操作`
  }
  const callSub = [
    `工具 ${calls.ordinaryToolTotal}`,
    `MCP ${calls.mcpTotal}`,
    `Skill ${calls.skillTotal}`,
    `子Agent ${calls.agentTotal}`
  ].join(' · ')
  const diffAdd = gitDiff.reduce((s, d) => s + d.added, 0)
  const diffDel = gitDiff.reduce((s, d) => s + d.deleted, 0)

  // 点调用/文件行 → 选中第一条匹配事件（右下「详情」展开它的入参/结果/文件，定位到那次调用）
  const jumpTo = (pred: (e: TraceEvent) => boolean): void => {
    const ev = all.find(pred)
    if (ev) onSelect(ev)
  }
  const keyboardActivate =
    (action: () => void) =>
    (ev: KeyboardEvent<HTMLDivElement>): void => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        action()
      }
    }
  const toggleTurnCallGroup = (key: string, ev: MouseEvent<HTMLButtonElement>): void => {
    ev.preventDefault()
    ev.stopPropagation()
    setExpandedTurnCallGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const showDangerAudit = (): void => {
    setOverviewDataTab('session')
    requestAnimationFrame(() => {
      dangerAuditRef.current?.scrollIntoView({ block: 'nearest' })
      dangerAuditRef.current?.focus({ preventScroll: true })
    })
  }
  const isOverviewTab = panelTab === 'overview'
  const isBillingTab = panelTab === 'billing'
  const isTrustTab = panelTab === 'mcpTrust'
  return (
    <aside className="panel">
      <div className="ov-topbar">
        <div className="panel-tabs" role="tablist" aria-label="面板视图">
          <button
            type="button"
            role="tab"
            aria-selected={isOverviewTab}
            className={isOverviewTab ? 'active' : ''}
            onClick={() => setPanelTab('overview')}
          >
            <Icon name="grid" /> 纵览
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isBillingTab}
            className={isBillingTab ? 'active' : ''}
            onClick={() => setPanelTab('billing')}
          >
            <Icon name="bulb" /> 账单卫士
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isTrustTab}
            className={isTrustTab ? 'active' : ''}
            onClick={() => setPanelTab('mcpTrust')}
          >
            <Icon name="lock" /> MCP 信任
          </button>
        </div>
      </div>
      <div className="ov-scroll">

      {isOverviewTab && (
        <div className={`ctx-gauge ${ctx ? (ctx.pct >= 80 ? 'hot' : ctx.pct >= 50 ? 'warm' : '') : 'empty'}`}>
          <div
            className="ring"
            style={ctx ? ({ '--p': Math.min(ctx.pct, 100) } as CSSProperties) : undefined}
            aria-label={ctx ? `上下文占用 ${ctx.pct}%` : '暂无上下文占用数据'}
          >
            <span>{ctx ? `${ctx.pct}%` : '—'}</span>
          </div>
          <div className="ctx-copy">
            <div className="lbl">上下文{ctx?.model ? ` · ${ctx.model}` : ''}</div>
            {ctx ? (
              <>
                <div className="v">
                  {fmtTok(ctx.used)} / {fmtTok(ctx.win)}
                </div>
                <div className="sub">
                  已占 {ctx.pct}% · 残余 {fmtTok(Math.max(0, ctx.win - ctx.used))} · 最近一轮完整 prompt÷窗口
                </div>
              </>
            ) : (
              <>
                <div className="v">暂无上下文数据</div>
                <div className="sub">仅在 Provider 同时上报上下文占用与模型窗口时显示</div>
              </>
            )}
          </div>
        </div>
      )}

      {isOverviewTab && turns.length > 0 && (
        <div className={`verdict-card ${vstate}`}>
          <div className="verdict-left">
            <div className="lbl">
              本会话 · {turns.length} 轮
              {busy && (
                <span className="live">
                  <span className="dot" />
                  运行中
                </span>
              )}
            </div>
            <div className={`judgement ${vstate}`}>
              <span className={`sdot ${vstate}`} />
              {judge}
            </div>
            <div className="since">
              {results.length} 轮完成 · {calls.totalCalls} 次调用
              {dangers.length > 0 ? ` · ${dangers.length} 处危险（审计放行）` : ''}
            </div>
          </div>
          <div className="verdict-right">
            <div className="verdict-pillar accent">
              <div className="nm">
                <span className="sdot" />
                总 Token
              </div>
              <div className="v">{billingTokenText}</div>
              <div className="sub">
                {billing.knownTokenResultCount}/{billing.resultTurns} 轮已捕获
              </div>
            </div>
            <div className="verdict-pillar">
              <div className="nm">
                <span className="sdot" />
                输入/输出
              </div>
              <div className="v">{fmtTok(totalTokens)}</div>
              <div className="sub">
                in {fmtTok(tin)} · out {fmtTok(tout)}
              </div>
            </div>
            <div className="verdict-pillar">
              <div className="nm">
                <span className="sdot" />
                调用
              </div>
              <div className="v">{calls.totalCalls}</div>
              <div className="sub">{callSub}</div>
            </div>
            {dangers.length > 0 ? (
              <button
                type="button"
                className={`verdict-pillar verdict-pillar-action ${dangerHi > 0 ? 'bad' : 'warn'}`}
                onClick={showDangerAudit}
                title={`查看本会话 ${dangers.length} 处危险操作`}
                aria-label={`查看本会话 ${dangers.length} 处危险操作`}
              >
                <div className="nm">
                  <span className="sdot" />
                  危险
                </div>
                <div className="v">{dangers.length}</div>
                <div className="sub danger-view-hint">
                  审计·未拦截 <Icon name="chevronRight" />
                </div>
              </button>
            ) : (
              <div className="verdict-pillar">
                <div className="nm">
                  <span className="sdot" />
                  危险
                </div>
                <div className="v">0</div>
                <div className="sub">无</div>
              </div>
            )}
          </div>
          {(cacheR != null || cacheW != null || apiMs != null) && (
            <div className="verdict-foot">
              <span className="it">
                <span>cache·r</span>
                <b>{fmtTok(cacheR)}</b>
              </span>
              <span className="it">
                <span>cache·w</span>
                <b>{fmtTok(cacheW)}</b>
              </span>
              <span className="it">
                <span>api</span>
                <b>{apiMs == null ? '—' : `${(apiMs / 1000).toFixed(1)}s`}</b>
              </span>
            </div>
          )}
        </div>
      )}

      {isOverviewTab && turns.length > 0 && (
        <div className="panel-section">
          <h4>会话</h4>
          <div className="filerow">
            <span className="fname">sessionId</span>
            <span className="dim session-id" title={sessionId ?? '尚未捕获 sessionId'}>
              {sessionId ?? '（尚未捕获）'}
            </span>
          </div>
        </div>
      )}

      {isOverviewTab && turns.length > 0 && (
        <div className="overview-data-tabs" role="tablist" aria-label="纵览数据维度">
          <button
            type="button"
            id="overview-turns-tab"
            role="tab"
            aria-selected={overviewDataTab === 'turns'}
            aria-controls="overview-turns-panel"
            className={overviewDataTab === 'turns' ? 'active' : ''}
            onClick={() => setOverviewDataTab('turns')}
          >
            轮次数据
          </button>
          <button
            type="button"
            id="overview-session-tab"
            role="tab"
            aria-selected={overviewDataTab === 'session'}
            aria-controls="overview-session-panel"
            className={overviewDataTab === 'session' ? 'active' : ''}
            onClick={() => setOverviewDataTab('session')}
          >
            会话数据
          </button>
        </div>
      )}

      {isBillingTab && (
        <div className="panel-section billing-section">
          <h4>
            账单卫士
            <span className="more">
              {billing.resultTurns === 0
                ? '等待结果'
                : billing.knownTokenResultCount === 0
                  ? 'token 未捕获'
                  : billing.missingTokenResultCount > 0
                    ? '部分 token'
                    : 'Token 统计'}
            </span>
          </h4>
          <div className="billing-source">
            <span className="source-pill estimate" title="来自当前 Provider 的原生 result/usage/modelUsage；只展示本会话能证明的 token。">
              {billing.sourceLabel}
            </span>
            <span className="source-pill off" title="不同厂商和模型价格不可直接混算；这里统一只看 token，不换算金额。">
              {billing.officialBillLabel}
            </span>
          </div>
          <div className="billing-grid">
            <div>
              <span>总 Token</span>
              <b>{billingTokenText}</b>
            </div>
            <div>
              <span>输入/输出</span>
              <b>{fmtTok(billing.tokensIn + billing.tokensOut)}</b>
            </div>
            <div>
              <span>缓存读/写</span>
              <b>
                {fmtTok(billing.cacheReadTokens)} / {fmtTok(billing.cacheCreationTokens)}
              </b>
            </div>
            <div>
              <span>API 耗时</span>
              <b>{billing.apiMs == null ? '—' : `${(billing.apiMs / 1000).toFixed(1)}s`}</b>
            </div>
          </div>
          <div className="billing-coverage">
            <span title="带 token usage 的 result / 全部 result；表示本会话有多少轮能做 token 统计。">
              轮次覆盖 {billing.knownTokenResultCount}/{billing.resultTurns} · {billing.tokenCoveragePct}%
            </span>
            <span title="modelUsage token 合计 / 本会话 token 合计；用于确认模型层明细是否完整。">
              模型明细 {billing.modelTokenCoveragePct}%
            </span>
            <span title={`${fmtTok(billing.workflowUnattributedTokens)} token 只能归到对应轮次；工具/Skill/MCP/Hook 没有独立 token 字段，所以不拆给具体工具。`}>
              工具拆分 暂无独立 token
            </span>
          </div>

          {billing.signals.length > 0 ? (
            <details className="billing-details billing-priority" open>
              <summary>
                行动信号 <span>{billing.signals.length}</span>
              </summary>
              {billing.signals.map((s, i) => {
                const action = (): void => {
                  if (s.evidence) onSelect(s.evidence)
                }
                return (
                  <div
                    className="billing-row click"
                    key={`${s.title}-${i}`}
                    onClick={action}
                    onKeyDown={keyboardActivate(action)}
                    role="button"
                    tabIndex={0}
                    title={s.action}
                  >
                    <span className={`sdot ${s.severity === 'bad' ? 'bad' : s.severity === 'warn' ? 'warn' : 'ok'}`} />
                    <span className="fname">{s.title}</span>
                    <span className="dim">{s.detail}</span>
                  </div>
                )
              })}
            </details>
          ) : (
            <div className="dim pad2">暂无符合规则的 token/上下文提示</div>
          )}

          {billing.topTokenTurns.length > 0 && (
            <details className="billing-details billing-priority" open>
              <summary>
                高 Token 轮次 <span>{billing.topTokenTurns.length}</span>
              </summary>
              <div className="billing-token-table">
                <div className="billing-token-row head">
                  <span>轮次</span>
                  <span>总 Token</span>
                  <span>缓存命中率</span>
                  <span>输入/输出</span>
                  <span>缓存读写</span>
                  <span>工具</span>
                  <span>上下文</span>
                </div>
                {billing.topTokenTurns.map((t) => {
                  const action = (): void => {
                    if (onOpenTurn) {
                      onOpenTurn(t.runId, t.result ?? null)
                      return
                    }
                    if (t.result) onSelect(t.result)
                  }
                  const total = fmtKnownTokens(t.tokensTotal, t.tokenKnown ? 1 : 0)
                  return (
                    <div
                      className="billing-token-row click"
                      key={t.runId}
                      onClick={action}
                      onKeyDown={keyboardActivate(action)}
                      role="button"
                      tabIndex={0}
                      title={highTokenTurnTitle(t)}
                      aria-label={`跳到第 ${t.turnNo} 轮对话，总 Token ${total}`}
                    >
                      <span className="turn-id">T{String(t.turnNo).padStart(2, '0')}</span>
                      <span className="tok-total">{total}</span>
                      <span>{highTokenTurnCacheHitRate(t)}</span>
                      <span>{highTokenTurnIoTokens(t)}</span>
                      <span>{highTokenTurnCacheTokens(t)}</span>
                      <span>{t.toolCount > 0 ? t.toolCount : '—'}</span>
                      <span>{highTokenTurnContext(t)}</span>
                    </div>
                  )
                })}
              </div>
            </details>
          )}

          <div className="psrc">
            按轮次统计 token；工具/Skill/MCP/Hook 没有独立 token 字段，所以不把整轮 token 分摊给具体工具。不同厂商/模型不在这里换算金额。
          </div>
        </div>
      )}

      {isTrustTab && (
        <McpTrustPanel
          report={mcpGuardReport}
          scanning={mcpGuardScanning}
          refreshing={mcpRefreshing}
          onScan={onMcpGuardScan}
          onRefreshLive={onMcpRefresh}
          onReportChange={onMcpGuardReportChange}
          runtimeProvider={runtimeProvider}
          mcpLive={mcpLive}
          mcps={mcps}
        />
      )}

      {isOverviewTab && (
        <div
          id="overview-turns-panel"
          role="tabpanel"
          aria-labelledby="overview-turns-tab"
          hidden={overviewDataTab !== 'turns'}
        >
      {turnCallRows.length > 0 && (
        <div className="panel-section turn-calls-section">
          <h4>
            每轮调用
            <span className="more">{turnCallRows.length} turns</span>
          </h4>
          <div className="turn-call-list">
            {turnCallRows.map((row) => {
              const mcpKey = `${row.runId}:mcp`
              const skillKey = `${row.runId}:skill`
              const timingKey = `${row.runId}:timing`
              const mcpExpanded = expandedTurnCallGroups.has(mcpKey)
              const skillExpanded = expandedTurnCallGroups.has(skillKey)
              const timingExpanded = expandedTurnCallGroups.has(timingKey)
              const duration = formatTurnDuration(row.result?.durationMs)
              const apiDuration = formatTurnDuration(row.result?.durationApiMs)
              const durationTitle = duration
                ? `整轮墙钟耗时 ${duration}${apiDuration ? `；其中 API 耗时 ${apiDuration}` : ''}`
                : undefined
              const timingToggleLabel = `${timingExpanded ? '收起' : '展开'}第 ${row.turnNo} 轮耗时明细`
              const action = (): void => {
                if (onOpenTurn) {
                  onOpenTurn(row.runId, row.firstEvent ?? row.result)
                  return
                }
                if (row.firstEvent) onSelect(row.firstEvent)
              }
              const label = `跳到第 ${row.turnNo} 轮，对话中共 ${row.total} 次工具/Skill/MCP/子 Agent 调用${duration ? `，耗时 ${duration}` : ''}`
              return (
                <div
                  className="turn-call-row"
                  key={row.runId}
                  title={row.userText || label}
                >
                  <button
                    type="button"
                    className="turn-id turn-call-open"
                    onClick={action}
                    title={label}
                    aria-label={label}
                  >
                    T{String(row.turnNo).padStart(2, '0')}
                  </button>
                  <div className="turn-call-main">
                    <div className="turn-call-head">
                      <b>{row.total} 次调用</b>
                      {(duration || row.timing.apiMs != null || row.timing.totalCalls > 0) && (
                        <button
                          type="button"
                          className="turn-call-duration-toggle"
                          title={timingExpanded ? '收起耗时明细' : durationTitle ?? '展开耗时明细'}
                          aria-label={timingToggleLabel}
                          aria-expanded={timingExpanded}
                          aria-controls={`turn-timing-${row.turnNo}`}
                          onClick={(event) => toggleTurnCallGroup(timingKey, event)}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          {duration ? `耗时 ${duration}` : '耗时明细'}
                        </button>
                      )}
                      {row.userText && <span className="turn-call-preview">{row.userText}</span>}
                    </div>
                    <div className="turn-call-groups">
                      {renderTurnCallGroup('tool', row.groups.tool)}
                      {(row.groups.mcp.length > 0 || row.groups.skill.length > 0) && (
                        <div className="turn-call-capability-groups">
                          {renderTurnCallGroup('mcp', row.groups.mcp, {
                            expanded: mcpExpanded,
                            onToggle: (ev) => toggleTurnCallGroup(mcpKey, ev)
                          })}
                          {renderTurnCallGroup('skill', row.groups.skill, {
                            expanded: skillExpanded,
                            onToggle: (ev) => toggleTurnCallGroup(skillKey, ev)
                          })}
                        </div>
                      )}
                      {renderTurnCallGroup('agent', row.groups.agent)}
                    </div>
                    {(mcpExpanded || skillExpanded) && (
                      <div className="turn-call-details">
                        {mcpExpanded && renderTurnCallDetail('mcp', row.groups.mcp)}
                        {skillExpanded && renderTurnCallDetail('skill', row.groups.skill)}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="turn-call-jump turn-call-open turn-call-timing-edge-toggle"
                    onClick={(event) => toggleTurnCallGroup(timingKey, event)}
                    onKeyDown={(event) => event.stopPropagation()}
                    title={timingToggleLabel}
                    aria-label={timingToggleLabel}
                    aria-expanded={timingExpanded}
                    aria-controls={`turn-timing-${row.turnNo}`}
                  >
                    <Icon name={timingExpanded ? 'chevronDown' : 'chevronRight'} />
                  </button>
                  {timingExpanded && (
                    <div id={`turn-timing-${row.turnNo}`} className="turn-call-timing-slot">
                      <TurnTimingDetails
                        timing={row.timing}
                        onOpenCall={(call) => {
                          if (onOpenTurn) {
                            onOpenTurn(row.runId, call.event, 'event')
                            return
                          }
                          onSelect(call.event)
                        }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="psrc">按每轮逻辑调用聚合；Skill 内部文件读取不重复计数。点 Txx 跳回该轮，点耗时或右侧箭头展开/收起明细。</div>
        </div>
      )}
        </div>
      )}

      {isOverviewTab && (
        <div
          id="overview-session-panel"
          role="tabpanel"
          aria-labelledby="overview-session-tab"
          hidden={overviewDataTab !== 'session'}
        >
      {isOverviewTab && topTools.rows.length > 0 && (
        <div className="panel-section top-tools-section">
          <h4>
            TOP TOOLS<span className="more">工具 {calls.ordinaryToolTotal} · MCP {calls.mcpTotal}</span>
          </h4>
          {topTools.rows.map((t) => {
            const c = topToolColor(t.name)
            return (
              <button
                type="button"
                className="toptool"
                key={t.name}
                onClick={() =>
                  jumpTo((e) =>
                    e.stage !== 'tool_result' &&
                    (t.name.startsWith('mcp:') ? e.mcpServer === t.name.slice(4) : e.tool === t.name)
                  )
                }
                title="点定位首次调用"
              >
                <span className={`tt-nm ${c}`}>{t.name}</span>
                <span className="tt-n">{t.count}</span>
                <span className={`mini-bar ${c}`}>
                  <i style={{ width: `${Math.round((t.count / topTools.max) * 100)}%` }} />
                </span>
              </button>
            )
          })}
        </div>
      )}

      {isOverviewTab && turns.length > 0 && (
        <div className="panel-section">
          <h4>
            HOOKS
            <span className="more">
              本会话 · 处理器 {hookSummary.logicalRuns} 实例 · 生命周期 {hookSummary.rawEvents} 条
            </span>
          </h4>
          {hookSummary.groups.length === 0 ? (
            <div className="dim pad2">本会话无 Hook 事件</div>
          ) : (
            hookSummary.groups.map((h) => {
              const tone = hookTone(h)
              return (
                <div className="hook-group" key={h.key}>
                  <button
                    type="button"
                    className="callrow hook-trigger"
                    onClick={() => h.last && onSelect(h.last)}
                    title="点查看最近一次 hook 事件"
                  >
                    <span className={`sdot ${tone}`} />
                    <span className="fname" title={`${h.event} · ${h.trigger}`}>
                      {h.event}
                    </span>
                    <span className="dim hook-name">{h.trigger}</span>
                    <span className="dim hook-count">
                      {h.triggerRuns == null ? '触发次数未单独上报' : `触发 ${h.triggerRuns} 次`}
                      {' · '}处理器 {h.logicalRuns} 实例 · 生命周期 {h.rawEvents} 条
                    </span>
                  </button>
                  {h.scripts.map((s) => {
                    const scriptTone = hookTone(s)
                    const target = s.lastError ?? s.lastCancelled ?? s.last
                    const failure = hookFailureText(s)
                    const cancellationTitle = hookCancellationTitle(s)
                    const configuredCommands = uniqueConfiguredCommands(s.instances)
                    const logicalHandlers = logicalHookRows(configuredCommands, s.command)
                    const displayedInstances = groupHookInstances(s.instances)
                    return (
                      <details className="hook-script overview-hook-script" key={s.key}>
                        <summary
                          className="callrow hook-row indent"
                          title={cancellationTitle ?? '点查看 Hook 执行详情'}
                        >
                          <span className={`sdot ${scriptTone}`} />
                          <span className="fname hook-command">{s.label}</span>
                          <span className="dim hook-detail">{hookDetailText(s)}</span>
                          <span className={`hook-status ${scriptTone}`}>{hookBadgeText(s)}</span>
                          <Icon name="chevronRight" className="hook-row-chev" />
                        </summary>
                        <div className="turn-hook-detail overview-hook-detail">
                          <div className="hook-actual-block">
                            <div className="hook-detail-label">
                              处理器实例 · {s.instances.length} 个
                              {displayedInstances.length < s.instances.length && ` · 合并为 ${displayedInstances.length} 组`}
                            </div>
                            <div className="hook-instance-list">
                              {displayedInstances.map((instance) => {
                                const averageDuration = formatTurnDuration(instance.averageDurationMs)
                                const timingTitle =
                                  instance.timedCount === instance.count
                                    ? `平均耗时：${averageDuration}`
                                    : `平均耗时：${averageDuration}（${instance.count} 个实例中 ${instance.timedCount} 个上报耗时）`
                                return (
                                  <button
                                    type="button"
                                    className="hook-instance"
                                    key={instance.key}
                                    onClick={() => onSelect(instance.last)}
                                    title="查看该组最近一次 Hook 的原始事件"
                                  >
                                    <span className="hook-instance-index">{instance.count}×</span>
                                    <span className="hook-instance-main">
                                      <strong>{instance.label}</strong>
                                      <span className="hook-instance-source">{instance.sources.join(' / ')}</span>
                                    </span>
                                    {averageDuration && (
                                      <span className="hook-instance-duration" title={timingTitle}>
                                        均 {averageDuration}
                                      </span>
                                    )}
                                    <span className={`hook-run-status ${instance.tone}`}>{instance.status}</span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          {logicalHandlers.length > 0 && (
                            <div className="hook-logical-block">
                              <div className="hook-detail-label">逻辑 Hook · {logicalHandlers.length} 个</div>
                              <div className="hook-logical-list">
                                {logicalHandlers.map((handler) => (
                                  <div className="hook-logical-row" key={handler.name}>
                                    <code>{handler.name}</code>
                                    <span>
                                      {handler.deliveries.length} 条投递 · {handler.deliveries.join(' / ')}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {configuredCommands.length > 0 && (
                            <details className="hook-config-deliveries">
                              <summary>
                                当前配置 · {configuredCommands.length} 条投递路径
                                <Icon name="chevronRight" />
                              </summary>
                              <p className="hook-configured-note">
                                这是当前配置反查，不代表本轮每条路径都实际执行。
                              </p>
                              <div className="hook-configured-list">
                                {configuredCommands.map((candidate, index) => (
                                  <div
                                    className="hook-configured-command"
                                    key={`${candidate.source}:${candidate.pluginId ?? ''}:${candidate.matcher ?? ''}:${candidate.command}:${index}`}
                                  >
                                    <span className={`hook-config-scope ${candidate.source}`}>
                                      {hookConfigScopeLabel(candidate.source)}
                                      {candidate.pluginId ? ` · ${candidate.pluginId.split('@')[0]}` : ''}
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
                            </details>
                          )}

                          {logicalHandlers.length === 0 && configuredCommands.length === 0 && (
                            <div className="dim">Provider 未上报具体 command，当前配置也没有可匹配项。</div>
                          )}

                          {failure && (
                            <button
                              type="button"
                              className="hook-failure"
                              onClick={() => target && onSelect(target)}
                              title={failure}
                            >
                              <span>最近失败</span>
                              <code>{failure}</code>
                            </button>
                          )}
                        </div>
                      </details>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
      )}

      {isOverviewTab && dangers.length > 0 && (
        <div className="panel-section danger-audit-section" ref={dangerAuditRef} tabIndex={-1}>
          <h4>
            <Icon name="alert" /> 危险操作审计（本会话）
          </h4>
          {dangers.map((e) => (
            <button
              type="button"
              className="callrow danger-audit-row"
              key={e.id}
              onClick={() => (onOpenTurn ? onOpenTurn(e.runId, e, 'event') : onSelect(e))}
              title={`跳到左侧对话中的这次 ${e.tool ?? e.name ?? '危险'} 调用`}
              aria-label={`跳到左侧对话中的这次 ${e.tool ?? e.name ?? '危险'} 调用：${e.danger!.reason}`}
            >
              <span className={`sdot ${e.danger!.level === 'danger' ? 'bad' : 'warn'}`} />
              <span className="fname" title={e.danger!.reason}>
                {e.danger!.reason}
              </span>
              <span className="dim">{e.tool ?? e.name}</span>
              <Icon name="chevronRight" className="danger-audit-jump" />
            </button>
          ))}
          <div className="psrc">观测标记（不阻塞、默认放行）· 已入库为 span</div>
        </div>
      )}

      {isOverviewTab && hasSkillSeg && (
        <div className="panel-section segment-section">
          <h4>
            段落（按 skill）
            <span className="more">{segments.length} 段</span>
          </h4>
          <div className="segment-list">
            {segments.map((s, i) => (
              <div className={`segment-row ${s.errors > 0 ? 'has-error' : ''}`} key={`${s.skill}-${i}`}>
                <span className="segment-index">{i + 1}</span>
                <span className="segment-name" title={s.skill}>
                  {s.skill === '（无 skill）' ? (
                    s.skill
                  ) : (
                    <>
                      <Icon name="box" /> {s.skill}
                    </>
                  )}
                </span>
                <span className="segment-metrics" aria-label={`${s.skill} 段指标`}>
                  <span className="seg-chip tool" title="普通工具调用数，不含子 agent">
                    <span>工具</span>
                    <b>{s.tools}</b>
                  </span>
                  {s.agents > 0 && (
                    <span className="seg-chip agent" title="子 agent / Task 调用数">
                      <span>子Agent</span>
                      <b>{s.agents}</b>
                    </span>
                  )}
                  {s.reads > 0 && (
                    <span className="seg-chip read" title="结构化读文件次数">
                      <span>读</span>
                      <b>{s.reads}</b>
                    </span>
                  )}
                  {s.writes > 0 && (
                    <span className="seg-chip write" title="结构化写入或编辑文件次数">
                      <span>写</span>
                      <b>{s.writes}</b>
                    </span>
                  )}
                  {s.errors > 0 && (
                    <span className="seg-chip err" title="本段错误次数">
                      <span>错误</span>
                      <b>{s.errors}</b>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="psrc">按实际 skill 调用切段 · tool 与子 agent 分开统计 · 不绑特定 workflow</div>
        </div>
      )}

      {isOverviewTab && (
        <div className="panel-section">
          <h4>调用明细（本会话）</h4>

          <div className="psub">Skill</div>
          {calls.skills.length === 0 ? (
            <div className="dim pad2">本会话无 Skill 调用</div>
          ) : (
            calls.skills.map((s) => (
              <button
                type="button"
                className="callrow"
                key={s.name}
                onClick={() => jumpTo((e) => e.kind === 'skill' && e.name === s.name && e.stage !== 'tool_result')}
                title="点查看这次 skill 调用的详情"
              >
                <span className="ckind">
                  <Icon name="box" />
                </span>
                <span className="fname" title={s.name}>
                  {s.name}
                </span>
                <span className="dim">{s.count}×</span>
              </button>
            ))
          )}

          <div className="psub">MCP</div>
          {calls.mcp.length === 0 ? (
            <div className="dim pad2">本会话无 MCP 调用</div>
          ) : (
            calls.mcp.map((g) => (
              <div key={g.server}>
                <div className="callserver">
                  <span className="ckind">
                    <Icon name="cube" />
                  </span>
                  <span className="fname">{g.server}</span>
                  <span className="dim">{g.total}×</span>
                </div>
                {g.actions.map((a) => (
                  <button
                    type="button"
                    className="callrow indent"
                    key={a.tool}
                    onClick={() => jumpTo((e) => (e.mcpTool ?? e.tool) === a.tool && e.stage !== 'tool_result')}
                    title={a.tool}
                  >
                    <span className="fname">{a.action}</span>
                    <span className="dim">{a.count}×</span>
                  </button>
                ))}
              </div>
            ))
          )}

          {calls.agents.length > 0 && (
            <>
              <div className="psub">子 Agent</div>
              {calls.agents.map((a) => (
                <button
                  type="button"
                  className="callrow"
                  key={a.name}
                  onClick={() => jumpTo((e) => e.kind === 'agent' && e.name === a.name && e.stage !== 'tool_result')}
                  title="点查看这次子 agent 调用的详情"
                >
                  <span className="ckind">
                    <Icon name="cube" />
                  </span>
                  <span className="fname" title={a.name}>
                    {a.name}
                  </span>
                  <span className="dim">{a.count}×</span>
                </button>
              ))}
            </>
          )}

          <div className="psub">工具</div>
          {calls.tools.length === 0 ? (
            <div className="dim pad2">本会话无工具调用</div>
          ) : (
            calls.tools.map((t) => (
              <button
                type="button"
                className="callrow"
                key={t.name}
                onClick={() =>
                  jumpTo((e) => e.kind === 'tool' && !e.isMcp && e.tool === t.name && e.stage !== 'tool_result')
                }
                title="点查看这次工具调用的详情"
              >
                <span className="ckind">
                  <Icon name="tool" />
                </span>
                <span className="fname" title={t.name}>
                  {t.name}
                </span>
                <span className="dim">{t.count}×</span>
              </button>
            ))
          )}
        </div>
      )}

      {isOverviewTab && (
        <div className="panel-section">
          <h4>
            <button
              type="button"
              className="panel-section-heading"
              title="R/W/E 来自结构化文件工具；~R 来自 cat、sed、rg 等只读 Bash 命令推断，其他间接文件访问仍可能未统计"
              aria-expanded={!filesFolded}
              aria-controls="overview-file-footprint"
              onClick={() => setFilesFolded((v) => !v)}
            >
              文件足迹（全会话 · 工具证据）
              <span className="more">
                {structured.length} files <Icon name={filesFolded ? 'chevronRight' : 'chevronDown'} />
              </span>
            </button>
          </h4>
          {!filesFolded && (
            <div id="overview-file-footprint">
              {coverage.written > 0 && (
                <div className="covrow">
                  改 {coverage.written} · 先读 {coverage.readBefore}/{coverage.written}
                  {coverage.inferredReadBefore > 0 && (
                    <span className="dim">（含 ~{coverage.inferredReadBefore} Bash 推断）</span>
                  )}
                  {coverage.blind.length > 0 && (
                    <span
                      className="cov-warn"
                      title={`以下文件首次修改前没有捕获到 Read 或可识别的只读 Bash 证据；仍可能存在未识别的间接读取：\n${coverage.blind.join('\n')}`}
                    >
                      {' '}
                      · <Icon name="alert" /> {coverage.blind.length} 无先读证据
                    </span>
                  )}
                </div>
              )}
              {structured.length === 0 && <div className="dim pad">暂无</div>}
              {structured.map((f) => (
                <button
                  type="button"
                  className="filerow click"
                  key={f.path}
                  onClick={() => jumpTo((e) => e.filePath === f.path && e.stage !== 'tool_result')}
                  title={f.path}
                >
                  <span className={`fbadge ${fileBadge(f).toLowerCase()}`}>{fileBadge(f)}</span>
                  <span className="fname">{basename(f.path)}</span>
                  <span className="dim fops">
                    {[
                      f.read - f.inferredRead > 0 && `R${f.read - f.inferredRead}`,
                      f.inferredRead > 0 && `~R${f.inferredRead}`,
                      f.write && `W${f.write}`,
                      f.edit && `E${f.edit}`
                    ].filter(Boolean).join(' ')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isOverviewTab &&
        gitDiff.length > 0 &&
        (() => {
          // P2 §8.4：工具足迹 vs 最终 diff 对照——diff 里的文件，工具碰过标 check，没碰过标 alert（diff 异常）
          const touched = new Set(structured.map((f) => f.path))
          return (
            <div className="panel-section">
              <h4>
                GIT DIFF
                <span className="more">
                  {gitDiff.length} files · +{diffAdd} −{diffDel}
                </span>
              </h4>
              {gitDiff.map((d) => (
                <div className="gdrow" key={d.path} title={d.path}>
                  <span className={`gd-mark ${touched.has(d.path) ? 'gd-add' : 'gd-del'}`}>
                    <Icon name={touched.has(d.path) ? 'check' : 'alert'} />
                  </span>
                  <span className="gd-path">{basename(d.path)}</span>
                  <span className="gd-add">+{d.added}</span>
                  <span className="gd-del">−{d.deleted}</span>
                </div>
              ))}
              <div className="psrc">check=结构化文件工具足迹内 · alert=未被结构化文件工具记录</div>
            </div>
          )
        })()}

      {isOverviewTab && usage && usage.turns > 0 && (
        <div className="panel-section">
          <h4>
            累计 Token 用量<span className="more">全部会话</span>
          </h4>
          <div className="pstats">
            <span className="fchip cost">
              {usage.tin == null || usage.tout == null ? '未提供 token' : `${fmtTok(usage.tin + usage.tout)} tok`}
            </span>
            <span className="fchip">
              {usage.tin == null ? '—' : fmtTok(usage.tin)}→{usage.tout == null ? '—' : fmtTok(usage.tout)} tok
            </span>
            <span className="fchip">{usage.turns} turns</span>
          </div>
          <div className="psrc">来自 usage.jsonl 持久化（每轮 SDK result usage 落盘，仅看 token，不算金额）</div>
        </div>
      )}
        </div>
      )}

      </div>
    </aside>
  )
}
