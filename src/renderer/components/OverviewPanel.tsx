// 右栏纵览（蓝本视觉）：会话 verdict 卡 + context 占用 + top tools + 文件足迹 + git diff。
import { useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import {
  mcpCallsForEvent,
  type TraceEvent,
  type DbStats,
  type Diagnostics,
  type DiffFile,
  type HookConfiguredCommand
} from '@shared/trace'
import type { AgentIntervention, RuntimeProvider } from '@shared/runtime'
import { isOverviewToolErrorEvent } from '@shared/logical-calls'
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
import type { FileRow, HookInstanceRow, HookScriptRow, HookSummary, Turn } from '../format'
import { displayDiffPath, sessionDiffSummary, sessionNetDiffSummary } from '../turn-diff'
import { HooksSummary } from './ChatTurn'
import { Icon } from './primitives/Icon'
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
  files: FileRow[]
  hooks: HookSummary
  interventions: AgentIntervention[]
}

function fileOperationText(file: FileRow): string {
  return [
    file.read - file.inferredRead > 0 && `R${file.read - file.inferredRead}`,
    file.inferredRead > 0 && `~R${file.inferredRead}`,
    file.write > 0 && `W${file.write}`,
    file.edit > 0 && `E${file.edit}`
  ].filter(Boolean).join(' ')
}

export function TurnFileFootprint({ files }: { files: FileRow[] }) {
  return (
    <section
      className="turn-file-footprint"
      aria-label="本轮文件足迹"
      title="R/W/E 来自本轮结构化文件工具；~R 来自本轮 cat、sed、rg 等只读 Bash 命令推断，其他间接文件访问仍可能未统计"
    >
      <div className="turn-file-heading">
        <span><Icon name="file" /> 本轮文件足迹（工具证据）</span>
        <span>{files.length} files</span>
      </div>
      {files.length === 0 ? (
        <div className="turn-file-empty">暂无文件工具证据</div>
      ) : (
        <div className="turn-file-list">
          {files.map((file) => (
            <div className="turn-file-row" key={file.path} title={file.path}>
              <span className={`fbadge ${fileBadge(file).toLowerCase()}`}>{fileBadge(file)}</span>
              <span className="fname">{basename(file.path)}</span>
              <span className="fops">{fileOperationText(file)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
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

type TurnDetailKind = 'mcp' | 'skill' | 'hooks' | 'file' | 'intervention'

const TURN_DETAIL_LABEL: Record<TurnDetailKind, string> = {
  mcp: 'MCP',
  skill: 'Skill',
  hooks: 'Hooks',
  file: '文件',
  intervention: '结构化介入'
}

function humanInterventions(events: TraceEvent[]): AgentIntervention[] {
  return events
    .flatMap((event) => event.intervention ? [event.intervention] : [])
    .filter((intervention) => intervention.resolution !== 'provider_cancelled')
}

function InterventionDetails({ interventions }: { interventions: AgentIntervention[] }): ReactNode {
  return (
    <div className="turn-intervention-detail">
      {interventions.map((intervention, interventionIndex) => (
        <div className="turn-intervention" key={intervention.request.questionId}>
          <div className="turn-intervention-head">
            <span>#{interventionIndex + 1} · {intervention.kind === 'permission' ? '权限确认' : '需求澄清'}</span>
            <small>
              {intervention.request.providerId ?? 'agent'} · {formatTurnDuration(intervention.durationMs) ?? '0.0s'}
            </small>
          </div>
          {intervention.request.questions.map((question) => (
            <div className="turn-intervention-answer" key={question.question}>
              <span title={question.question}>{question.header} · {question.question}</span>
              <b>
                {intervention.response.behavior === 'answered'
                  ? intervention.response.answers[question.question]
                  : '用户取消'}
              </b>
            </div>
          ))}
          <div className="turn-intervention-source">{intervention.source}</div>
        </div>
      ))}
    </div>
  )
}

function renderTurnDetailToggle(args: {
  kind: TurnDetailKind
  count: number
  expanded: boolean
  controls: string
  onToggle: (ev: MouseEvent<HTMLButtonElement>) => void
}): ReactNode {
  const label = TURN_DETAIL_LABEL[args.kind]
  const available = args.count > 0
  return (
    <button
      type="button"
      className={`turn-call-group turn-call-toggle ${args.kind}`}
      title={available ? `${args.expanded ? '收起' : '展开'} ${label} 明细` : `本轮无 ${label} 明细`}
      aria-label={`${label} ${args.count}${available ? `，${args.expanded ? '收起' : '展开'}明细` : '，无明细'}`}
      aria-expanded={available ? args.expanded : false}
      aria-controls={available ? args.controls : undefined}
      disabled={!available}
      onClick={args.onToggle}
      onKeyDown={(ev) => ev.stopPropagation()}
    >
      <span className="turn-call-kind">{label}</span>
      <span className="turn-call-count">{args.count}</span>
      <span className="turn-call-toggle-icon">
        <Icon name={args.expanded ? 'chevronDown' : 'chevronRight'} />
      </span>
    </button>
  )
}

function renderTurnCallDetail(kind: 'mcp' | 'skill', items: TurnCallItem[]): ReactNode {
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
  selected,
  usage,
  stats,
  runtimeProvider,
  gitDiff = [],
  busy = false,
  onSelect,
  onOpenTurn,
  onOpenSessionDiff
}: {
  turns: Turn[]
  sessionId?: string | null
  selected: TraceEvent | null
  usage: { cost: number | null; tin: number | null; tout: number | null; turns: number } | null
  stats: DbStats | null
  runtimeProvider?: RuntimeProvider
  gitDiff?: DiffFile[]
  diag?: Diagnostics | null
  busy?: boolean
  onSelect: (ev: TraceEvent) => void
  onOpenTurn?: (runId: string, ev?: TraceEvent | null, target?: 'turn' | 'event') => void
  onOpenSessionDiff?: (path?: string) => void
}) {
  const [filesFolded, setFilesFolded] = useState(false)
  const [overviewDataTab, setOverviewDataTab] = useState<'turns' | 'session'>('turns')
  const [expandedTurnCallGroups, setExpandedTurnCallGroups] = useState<Set<string>>(() => new Set())
  const dangerAuditRef = useRef<HTMLDivElement>(null)
  const all = useMemo(() => turns.flatMap((t) => t.items), [turns])
  const compactions = useMemo(
    () => all.filter((event) => event.kind === 'harness' && event.stage === 'context_compaction'),
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
  const results = turns.map(resultOf).filter((event): event is TraceEvent => event != null)
  const sumObserved = (pick: (event: TraceEvent) => number | undefined): { value: number | null; known: number } => {
    const values = results.map(pick).filter((value): value is number => value != null)
    return {
      value: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null,
      known: values.length
    }
  }
  const formatObserved = (evidence: { value: number | null; known: number }, format: (value: number) => string = fmtTok): string =>
    evidence.value == null ? '—' : `${evidence.known < turns.length ? '≥ ' : ''}${format(evidence.value)}`
  const tin = sumObserved((e) => e.tokensIn)
  const tout = sumObserved((e) => e.tokensOut)
  // verdict foot 用全会话累计（和 cost/tokens pillar 一致，不混最后一轮）。
  const cacheR = sumObserved((e) => e.cacheReadTokens)
  const cacheW = sumObserved((e) => e.cacheCreationTokens)
  const reasoning = sumObserved((e) => e.reasoningTokens)
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
          timing: buildTurnTimingBreakdown(turn.items, logicalEvents, result ?? undefined),
          files: aggregateFiles(turn.items).structured,
          hooks: aggregateHooks(turn.items),
          interventions: humanInterventions(turn.items)
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
  const dangerClassification = runtimeProvider == null
    ? 'unknown'
    : runtimeProvider === 'claude_sdk' || runtimeProvider === 'qoder_cli'
      ? 'classified'
      : 'unsupported'
  const toolErrors = all.filter(isOverviewToolErrorEvent).length
  const turnError = turns.some((t) => !!t.error)
  const hasError = toolErrors > 0 || turnError
  let vstate: 'ok' | 'warn' | 'bad' = 'ok'
  let judge = '轮次已结束'
  if (busy) {
    vstate = 'warn'
    judge = '运行中'
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
  const callSub = [
    `工具 ${calls.ordinaryToolTotal}`,
    `MCP ${calls.mcpTotal}`,
    `Skill ${calls.skillTotal}`,
    `子Agent ${calls.agentTotal}`
  ].join(' · ')
  const diffAdd = gitDiff.reduce((s, d) => s + d.added, 0)
  const diffDel = gitDiff.reduce((s, d) => s + d.deleted, 0)
  const sessionNetDiff = useMemo(() => sessionNetDiffSummary(turns), [turns])
  const sessionActivity = useMemo(() => sessionDiffSummary(turns), [turns])
  const sessionDiffRepoRoot = useMemo(() => {
    for (let index = turns.length - 1; index >= 0; index--) {
      const root = turns[index].items.find((item) => item.turnDiff?.repoRoot)?.turnDiff?.repoRoot
      if (root) return root
    }
    return undefined
  }, [turns])

  // 点调用/文件行 → 选中第一条匹配事件（右下「详情」展开它的入参/结果/文件，定位到那次调用）
  const jumpTo = (pred: (e: TraceEvent) => boolean): void => {
    const ev = all.find(pred)
    if (ev) onSelect(ev)
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
  return (
    <aside className="panel overview-dossier" data-screen-label="总览 · 当前会话证据" aria-label="当前执行总览">
      <div className="ov-topbar">
        <div className="overview-panel-title">
          <div><strong>总览</strong><span>{busy ? '当前执行' : '会话证据'}</span></div>
          <em><i aria-hidden="true" />本机真实数据</em>
        </div>
      </div>
      <div className="ov-scroll overview-scroll-content">

      {(
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

      {turns.length > 0 && (
        <section className={`overview-verdict ${vstate}`} aria-label="当前会话判词与尺度">
          <header className="overview-verdict-line">
            <div>
              <span className={`sdot ${vstate}`} />
              <strong>{judge}</strong>
              <small>
                {busy
                  ? '正在等待 Provider 终态'
                  : `${results.length} 轮已结束 · ${toolErrors} 处工具报错${
                      sessionInterventions.length > 0 ? ` · ${sessionInterventions.length} 次结构化介入` : ''
                    } · Provider 终态不代表用户目标完成`}
              </small>
            </div>
            <em>{calls.totalCalls} calls</em>
          </header>
          <div className="overview-metric-grid">
            <div className="overview-metric accent">
              <span>输入+输出+缓存</span>
              <strong>{billingTokenText}</strong>
              <small>{billing.knownTokenResultCount}/{billing.resultTurns} 轮已捕获 · reasoning 单列</small>
            </div>
            <div className="overview-metric">
              <span>输入 / 输出</span>
              <strong>{formatObserved(tin)} / {formatObserved(tout)}</strong>
              <small>input / output · 缺失轮次保留为下界</small>
            </div>
            <div className="overview-metric">
              <span>调用</span>
              <strong>{calls.totalCalls}</strong>
              <small>{callSub}</small>
            </div>
            {dangers.length > 0 ? (
              <button
                type="button"
                className={`overview-metric overview-metric-action ${dangerHi > 0 ? 'bad' : 'warn'}`}
                onClick={showDangerAudit}
                title={`查看本会话 ${dangers.length} 处危险操作`}
                aria-label={`查看本会话 ${dangers.length} 处危险操作`}
              >
                <span>危险</span>
                <strong>{dangers.length}</strong>
                <small>审计·未拦截 <Icon name="chevronRight" /></small>
              </button>
            ) : dangerClassification === 'classified' ? (
              <div className="overview-metric true-zero">
                <span>危险</span>
                <strong>0</strong>
                <small>完整分类范围内无事件</small>
              </div>
            ) : (
              <div className="overview-metric unsupported">
                <span>危险</span>
                <strong>—</strong>
                <small>{dangerClassification === 'unsupported' ? '当前 Provider 分类未支持' : '能力状态未知'}</small>
              </div>
            )}
          </div>
          <footer className="overview-metric-foot">
            <span><b>cache·r</b>{formatObserved(cacheR)}</span>
            <span><b>cache·w</b>{formatObserved(cacheW)}</span>
            <span><b>reason</b>{formatObserved(reasoning)}</span>
            <span><b>api</b>{formatObserved(apiMs, (value) => `${(value / 1000).toFixed(1)}s`)}</span>
          </footer>
        </section>
      )}

      {turns.length > 0 && (
        <div className="panel-section">
          <h4>会话</h4>
          <div className="filerow">
            <span className="fname">sessionId</span>
            <span className="dim session-id" title={sessionId ?? '尚未捕获 sessionId'}>
              {sessionId ?? '（尚未捕获）'}
            </span>
          </div>
          <div className="filerow">
            <span className="fname">Compact</span>
            <span className="dim">{compactions.length} 次</span>
          </div>
        </div>
      )}

      {turns.length > 0 && (
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

      {(
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
              const hooksKey = `${row.runId}:hooks`
              const fileKey = `${row.runId}:file`
              const timingKey = `${row.runId}:timing`
              const interventionKey = `${row.runId}:intervention`
              const mcpCount = row.groups.mcp.reduce((sum, item) => sum + item.count, 0)
              const skillCount = row.groups.skill.reduce((sum, item) => sum + item.count, 0)
              const agentCount = row.groups.agent.reduce((sum, item) => sum + item.count, 0)
              const hooksCount = row.hooks.logicalRuns
              const timingAvailable = Boolean(row.timing.apiMs != null || row.timing.totalCalls > 0)
              const mcpExpanded = mcpCount > 0 && expandedTurnCallGroups.has(mcpKey)
              const skillExpanded = skillCount > 0 && expandedTurnCallGroups.has(skillKey)
              const hooksExpanded = hooksCount > 0 && expandedTurnCallGroups.has(hooksKey)
              const fileExpanded = row.files.length > 0 && expandedTurnCallGroups.has(fileKey)
              const timingExpanded = timingAvailable && expandedTurnCallGroups.has(timingKey)
              const interventionExpanded = row.interventions.length > 0 && expandedTurnCallGroups.has(interventionKey)
              const timingToggleLabel = `${timingExpanded ? '收起' : '展开'}第 ${row.turnNo} 轮耗时明细`
              const action = (): void => {
                if (onOpenTurn) {
                  onOpenTurn(row.runId, row.firstEvent ?? row.result)
                  return
                }
                if (row.firstEvent) onSelect(row.firstEvent)
              }
              const label = `跳到第 ${row.turnNo} 轮，对话中共 ${row.total} 次工具/Skill/MCP/子 Agent 调用`
              const isSelectedTurn = selected?.runId === row.runId
              return (
                <div
                  className={`turn-call-row ${isSelectedTurn ? 'is-selected' : ''}`}
                  key={row.runId}
                  title={row.userText || label}
                >
                  <button
                    type="button"
                    className="turn-id turn-call-open"
                    onClick={action}
                    title={label}
                    aria-label={label}
                    aria-current={isSelectedTurn ? 'true' : undefined}
                  >
                    T{String(row.turnNo).padStart(2, '0')}
                  </button>
                  <div className="turn-call-main">
                    {row.userText && (
                      <div className="turn-call-head">
                        <span className="turn-call-preview">{row.userText}</span>
                      </div>
                    )}
                    <div className="turn-call-groups">
                      {timingAvailable && (
                        <button
                          type="button"
                          className="turn-call-group turn-call-toggle timing"
                          title={timingExpanded ? '收起耗时明细' : '查看模型响应耗时与非模型耗时'}
                          aria-label={timingToggleLabel}
                          aria-expanded={timingExpanded}
                          aria-controls={`turn-timing-${row.turnNo}`}
                          onClick={(event) => toggleTurnCallGroup(timingKey, event)}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <span className="turn-call-kind">耗时</span>
                          <span className="turn-call-count">2 项</span>
                          <span className="turn-call-toggle-icon">
                            <Icon name={timingExpanded ? 'chevronDown' : 'chevronRight'} />
                          </span>
                        </button>
                      )}
                      {renderTurnDetailToggle({
                        kind: 'intervention', count: row.interventions.length, expanded: interventionExpanded,
                        controls: `turn-interventions-${row.turnNo}`,
                        onToggle: (event) => toggleTurnCallGroup(interventionKey, event)
                      })}
                      {renderTurnDetailToggle({
                        kind: 'mcp', count: mcpCount, expanded: mcpExpanded,
                        controls: `turn-mcp-${row.turnNo}`,
                        onToggle: (event) => toggleTurnCallGroup(mcpKey, event)
                      })}
                      {renderTurnDetailToggle({
                        kind: 'skill', count: skillCount, expanded: skillExpanded,
                        controls: `turn-skill-${row.turnNo}`,
                        onToggle: (event) => toggleTurnCallGroup(skillKey, event)
                      })}
                      <span
                        className={`turn-call-group agent${agentCount === 0 ? ' empty' : ''}`}
                        title={`本轮子 Agent 调用 ${agentCount} 次`}
                      >
                        <span className="turn-call-kind">子Agent</span>
                        <span className="turn-call-count">{agentCount}</span>
                      </span>
                      {renderTurnDetailToggle({
                        kind: 'hooks', count: hooksCount, expanded: hooksExpanded,
                        controls: `turn-hooks-${row.turnNo}`,
                        onToggle: (event) => toggleTurnCallGroup(hooksKey, event)
                      })}
                      {renderTurnDetailToggle({
                        kind: 'file', count: row.files.length, expanded: fileExpanded,
                        controls: `turn-files-${row.turnNo}`,
                        onToggle: (event) => toggleTurnCallGroup(fileKey, event)
                      })}
                    </div>
                  </div>
                  {(timingExpanded || interventionExpanded || mcpExpanded || skillExpanded || hooksExpanded || fileExpanded) && (
                    <div className="turn-call-detail-slot">
                      {timingExpanded && (
                        <div id={`turn-timing-${row.turnNo}`}>
                          <TurnTimingDetails timing={row.timing} />
                        </div>
                      )}
                      {interventionExpanded && (
                        <div id={`turn-interventions-${row.turnNo}`}>
                          <InterventionDetails interventions={row.interventions} />
                        </div>
                      )}
                      {mcpExpanded && (
                        <div id={`turn-mcp-${row.turnNo}`}>{renderTurnCallDetail('mcp', row.groups.mcp)}</div>
                      )}
                      {skillExpanded && (
                        <div id={`turn-skill-${row.turnNo}`}>{renderTurnCallDetail('skill', row.groups.skill)}</div>
                      )}
                      {hooksExpanded && (
                        <div id={`turn-hooks-${row.turnNo}`}><HooksSummary summary={row.hooks} title="Hooks 明细" /></div>
                      )}
                      {fileExpanded && (
                        <div id={`turn-files-${row.turnNo}`}><TurnFileFootprint files={row.files} /></div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="psrc">每轮展示结构化介入、MCP、Skill、子 Agent、Hook 与文件数量；介入仅统计结构化问答/权限请求，不对普通文本（如“请登录”）做 NLP 推断。</div>
        </div>
      )}
        </div>
      )}

      {(
        <div
          id="overview-session-panel"
          role="tabpanel"
          aria-labelledby="overview-session-tab"
          hidden={overviewDataTab !== 'session'}
        >
      {(sessionInterventions.length > 0 || (stats?.interventions?.requested ?? 0) > 0) && (
        <div className="panel-section intervention-summary-section">
          <h4>
            结构化介入
            <span className="more">本会话 {sessionInterventions.length} 次 · {sessionQuestions} 个问题</span>
          </h4>
          <div className="intervention-summary-grid">
            <div><span>需求澄清</span><b>{sessionClarifications}</b></div>
            <div><span>权限确认</span><b>{sessionPermissions}</b></div>
            <div><span>累计等待</span><b>{formatTurnDuration(sessionWaitMs) ?? '0.0s'}</b></div>
          </div>
          {stats?.interventions && (
            <div className="psrc">
              SQLite 历史累计：结构化介入 {stats.interventions.total} 次 · 问题 {stats.interventions.questions} 个
              {stats.interventions.requested > stats.interventions.total
                ? ` · 另有 ${stats.interventions.requested - stats.interventions.total} 次由 Provider 取消，不计入结构化介入`
                : ''}
            </div>
          )}
        </div>
      )}
      {topTools.rows.length > 0 && (
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

      {turns.length > 0 && (
        <div className="panel-section hooks-section">
          <h4 className="hooks-heading">
            <span>HOOKS</span>
            <span
              className="hook-summary-stats"
              aria-label={`本会话 Hook：事件 ${hookSummary.groups.length} 类，${hookSummary.logicalRuns} 次执行，${hookSummary.rawEvents} 条生命周期事件`}
            >
              <span>事件 {hookSummary.groups.length} 类</span>
              <span>{hookSummary.logicalRuns} 次执行</span>
              <span>{hookSummary.rawEvents} 条事件</span>
            </span>
          </h4>
          {hookSummary.groups.length === 0 ? (
            <div className="dim pad2">本会话无 Hook 事件</div>
          ) : (
            hookSummary.groups.map((h) => {
              const tone = hookTone(h)
              const triggerLabel = h.trigger === h.event
                ? null
                : h.trigger.startsWith(`${h.event}:`)
                  ? h.trigger.slice(h.event.length + 1)
                  : h.trigger
              return (
                <div className="hook-group" key={h.key}>
                  <button
                    type="button"
                    className="callrow hook-trigger"
                    onClick={() => h.last && onSelect(h.last)}
                    title="点查看最近一次 hook 事件"
                  >
                    <span className={`sdot ${tone}`} />
                    <span className="hook-trigger-main">
                      <span className="fname" title={`${h.event} · ${h.trigger}`}>
                        {h.event}
                      </span>
                      {triggerLabel && <span className="dim hook-name">{triggerLabel}</span>}
                    </span>
                    <span className="dim hook-count">
                      {h.triggerRuns != null && <>{h.triggerRuns} 次触发 · </>}
                      {h.logicalRuns} 次执行 · {h.rawEvents} 条事件
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
                    const badgeText = hookBadgeText(s)
                    const detailText = hookDetailText(s)
                    const secondaryDetail = detailText && !badgeText.startsWith(detailText) ? detailText : null
                    return (
                      <details className="hook-script overview-hook-script" key={s.key}>
                        <summary
                          className="callrow hook-row indent"
                          title={cancellationTitle ?? '点查看 Hook 执行详情'}
                        >
                          <span className="fname hook-command">{s.label}</span>
                          {secondaryDetail && <span className="dim hook-detail">{secondaryDetail}</span>}
                          <span className={`hook-status ${scriptTone}`}>{badgeText}</span>
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

      {dangers.length > 0 && (
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

      {hasSkillSeg && (
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

      {(
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

      {(
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
                  <span className="dim fops">{fileOperationText(f)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {(sessionNetDiff || sessionActivity.turnCount > 0) && (
        <div className="panel-section">
          <h4>
            {onOpenSessionDiff ? (
              <button
                type="button"
                className="panel-section-heading"
                title={sessionNetDiff
                  ? '本会话从第一轮开始前基线到当前的真实 Git 净改动；点击在右侧 Diff 中审阅'
                  : '旧会话仅有逐轮快照累计活动量：同一行跨轮反复改会重复计入，不等于工作树净改动'}
                onClick={() => onOpenSessionDiff()}
              >
                {sessionNetDiff ? '本会话净改动' : `本会话活动（${sessionActivity.turnCount} 轮快照累计）`}
                <span className="more">
                  {(sessionNetDiff?.files ?? sessionActivity.files).length} files · +{sessionNetDiff?.added ?? sessionActivity.added} −{sessionNetDiff?.deleted ?? sessionActivity.deleted}{' '}
                  <Icon name="chevronRight" />
                </span>
              </button>
            ) : (
              <>
                {sessionNetDiff ? '本会话净改动' : `本会话活动（${sessionActivity.turnCount} 轮快照累计）`}
                <span className="more">
                  {(sessionNetDiff?.files ?? sessionActivity.files).length} files · +{sessionNetDiff?.added ?? sessionActivity.added} −{sessionNetDiff?.deleted ?? sessionActivity.deleted}
                </span>
              </>
            )}
          </h4>
          {(sessionNetDiff?.files ?? sessionActivity.files).map((file) =>
            onOpenSessionDiff ? (
              <button
                type="button"
                className="gdrow click"
                key={file.path}
                title={sessionNetDiff ? `${file.path} · 在右侧会话 Diff 中打开` : `${file.path} · 在右侧最近一轮 Diff 中打开`}
                onClick={() => onOpenSessionDiff(file.path)}
              >
                <span className="gd-path">{displayDiffPath(file.path, sessionDiffRepoRoot)}</span>
                {'turns' in file && file.turns > 1 && <span className="dim">{file.turns} 轮</span>}
                {file.binary && !file.added && !file.deleted ? (
                  <span className="dim">binary</span>
                ) : (
                  <>
                    <span className="gd-add">+{file.added}</span>
                    <span className="gd-del">−{file.deleted}</span>
                  </>
                )}
                <Icon name="chevronRight" className="gd-open" />
              </button>
            ) : (
              <div className="gdrow" key={file.path} title={file.path}>
                <span className="gd-path">{displayDiffPath(file.path, sessionDiffRepoRoot)}</span>
                {'turns' in file && file.turns > 1 && <span className="dim">{file.turns} 轮</span>}
                <span className="gd-add">+{file.added}</span>
                <span className="gd-del">−{file.deleted}</span>
              </div>
            )
          )}
          <div className="psrc">
            {sessionNetDiff
              ? '来源=会话首轮前 Git 基线 → 当前工作树；+/− 是真实净改动'
              : '来源=旧会话每轮 Git 工作树快照；+/− 是累计活动量，不是当前工作树净改动'}
          </div>
        </div>
      )}

      {gitDiff.length > 0 &&
        (() => {
          // P2 §8.4：工具足迹 vs 工作区 diff 对照——diff 里的文件，工具碰过标 check，没碰过标 alert
          const touched = new Set(structured.map((f) => f.path))
          return (
            <div className="panel-section">
              <h4>
                工作区未提交改动（vs HEAD）
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
                  {d.binary ? (
                    <span className="dim">binary</span>
                  ) : (
                    <>
                      <span className="gd-add">+{d.added}</span>
                      <span className="gd-del">−{d.deleted}</span>
                    </>
                  )}
                </div>
              ))}
              <div className="psrc">
                当前工作树对比 HEAD（含未跟踪新文件，不含 ignored）· 含本会话之外的改动 · check=结构化文件工具足迹内 ·
                alert=未被结构化文件工具记录
              </div>
            </div>
          )
        })()}

      {usage && usage.turns > 0 && (
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
