// 右栏纵览（蓝本视觉）：会话 verdict 卡 + context 占用 + top tools + 文件足迹 + git diff。
import { memo, useId, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { useSampledTurns } from '../hooks/useSampledTurns'
import { workspaceDiffCopy } from '@shared/constants/copy'
import { latestBackgroundWork } from '@shared/background-work'
import { backgroundWorkStatus } from '../background-work-status'
import {
  contextCompactionOf,
  contextUsageEvidence,
  mcpCallsForEvent,
  type TraceEvent,
  type DbStats,
  type DiffFile,
  type WorkspaceDiffResult,
  type HookConfiguredCommand,
  type TurnDiffSnapshot
} from '@shared/trace'
import type { AgentIntervention, RuntimeProvider } from '@shared/runtime'
import { isOverviewToolErrorEvent } from '@shared/logical-calls'
import { isInferredSkillLoad } from '../skill-load-evidence'
import { buildTurnTimingBreakdown, type TurnTimingBreakdown } from '../turn-timing'
import {
  aggregateHooks,
  aggregateCalls,
  aggregateFiles,
  cacheHitEvidence,
  aggregateSegments,
  analyzeBilling,
  basename,
  fileBadge,
  fileWriteCoverage,
  fmtTok,
  hookCancellationDetail,
  hookCommandLabel,
  logicalCallEventsForTurn,
  resultOf
} from '../format'
import type { FileRow, HookInstanceRow, HookScriptRow, HookSummary, Turn } from '../format'
import { displayDiffPath, sessionDiffSummary, sessionNetDiffSummary, turnDiffViewOf } from '../turn-diff'
import { OVERVIEW_COST_COPY, OVERVIEW_SESSION_COPY } from '../constants/copy'
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

function formatOverviewCost(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}

function formatOverviewCredits(value: number): string {
  if (value > 0 && value < 0.01) return '<0.01'
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export interface OverviewToolError {
  event: TraceEvent
  result: TraceEvent
  tool: string
  input: unknown
  output?: string
  message: string
}

function nestedErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['error', 'message', 'detail']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key]
  }
  if (Array.isArray(record.content)) {
    const text = record.content
      .flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
        ? [(item as Record<string, unknown>).text as string]
        : [])
      .join('\n')
    if (text.trim()) return text
  }
  return undefined
}

function errorMessageFromOutput(output?: string): string {
  if (!output) return '工具未返回错误详情'
  let detail = output
  try {
    detail = nestedErrorMessage(JSON.parse(output)) ?? output
  } catch {
    // 非 JSON 输出直接作为 Provider 的原始错误证据展示。
  }
  const normalized = detail
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized ? `${normalized.slice(0, 280)}${normalized.length > 280 ? '…' : ''}` : '工具未返回错误详情'
}

export function overviewToolErrors(events: TraceEvent[]): OverviewToolError[] {
  const callsById = new Map<string, TraceEvent>()
  for (const event of events) {
    if (!event.toolUseId || event.stage === 'tool_result') continue
    const key = `${event.runId}\0${event.toolUseId}`
    const current = callsById.get(key)
    if (!current || (current.input == null && event.input != null)) callsById.set(key, event)
  }
  return events.filter(isOverviewToolErrorEvent).map((result) => {
    const call = result.toolUseId ? callsById.get(`${result.runId}\0${result.toolUseId}`) : undefined
    const output = result.output ?? result.text
    const tool = call?.isMcp
      ? call.mcpAction
        ? `${call.mcpServer ?? 'mcp'}.${call.mcpAction}`
        : call.mcpTool ?? call.mcpServer ?? 'MCP'
      : call?.tool ?? call?.name ?? result.tool ?? result.name ?? '工具'
    return {
      event: call ?? result,
      result,
      tool,
      input: call?.input,
      ...(output != null ? { output } : {}),
      message: errorMessageFromOutput(output)
    }
  })
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
  turnDiff?: TurnDiffSnapshot
  turnDiffPreview: boolean
  hooks: HookSummary
  interventions: AgentIntervention[]
  errors: OverviewToolError[]
}

function fileOperationText(file: FileRow): string {
  return [
    file.read - file.inferredRead > 0 && `R${file.read - file.inferredRead}`,
    file.inferredRead > 0 && `~R${file.inferredRead}`,
    file.write > 0 && `W${file.write}`,
    file.edit > 0 && `E${file.edit}`
  ].filter(Boolean).join(' ')
}

function turnFileCount(row: Pick<TurnCallRow, 'files' | 'turnDiff'>): number {
  return row.turnDiff?.status === 'captured' ? row.turnDiff.files.length : row.files.length
}

interface ChangeBadge {
  label: string
  tone: string
  title: string
}

function normalizedEvidencePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function diffChangeBadge(file: DiffFile, structured: FileRow[]): ChangeBadge {
  const path = normalizedEvidencePath(file.path)
  const tool = structured.find((candidate) => normalizedEvidencePath(candidate.path) === path)
  if (tool?.write) return { label: 'W', tone: 'w', title: 'W：本轮 Write 工具证据；文件与行数来自 Git 净改动' }
  if (tool?.edit) return { label: 'E', tone: 'e', title: 'E：本轮 Edit 工具证据；文件与行数来自 Git 净改动' }

  const inferredChange = file.change ?? (file.patch?.includes('\nnew file mode ') ? 'added' : file.patch?.includes('\ndeleted file mode ') ? 'deleted' : file.patch ? 'modified' : undefined)
  if (inferredChange === 'added') return { label: 'A', tone: 'a', title: 'A：Git 证明本轮新增文件；具体工具类型未观测' }
  if (inferredChange === 'modified') return { label: 'M', tone: 'm', title: 'M：Git 证明本轮修改文件；具体工具类型未观测' }
  if (inferredChange === 'deleted') return { label: 'D', tone: 'd', title: 'D：Git 证明本轮删除文件；具体工具类型未观测' }

  const label = file.added > 0 && file.deleted > 0 ? '±' : file.added > 0 ? '+' : file.deleted > 0 ? '−' : 'Δ'
  return { label, tone: 'delta', title: 'Git 证明文件有净改动；旧记录未采集新增/修改/删除状态' }
}

export function TurnFileFootprint({
  files,
  turnDiff,
  preview = false
}: {
  files: FileRow[]
  turnDiff?: TurnDiffSnapshot
  preview?: boolean
}) {
  const hasDiff = turnDiff?.status === 'captured'
  const diffFiles = hasDiff ? turnDiff.files : []
  const count = hasDiff ? diffFiles.length : files.length
  return (
    <section
      className="turn-file-footprint"
      aria-label="本轮文件足迹"
      title={hasDiff
        ? '文件集合与行数来自 Git 净改动；匹配到结构化工具证据时显示 W/E，否则显示 Git 的 A/M/D。只有 Git 快照不可用时才降级到工具足迹'
        : 'R/W/E 来自本轮结构化文件工具；~R 来自本轮 cat、sed、rg 等只读 Bash 命令推断，其他间接文件访问仍可能未统计'}
    >
      <div className="turn-file-heading">
        <span><Icon name="file" /> {hasDiff ? `本轮改动（Git 证据${preview ? ' · 运行中预览' : ''}）` : '本轮文件足迹（工具证据）'}</span>
        <span>{count} files</span>
      </div>
      {hasDiff ? (
        <div className="turn-file-list">
          {diffFiles.map((file) => {
            const badge = diffChangeBadge(file, files)
            return (
              <div className="turn-file-row" key={file.path} title={file.path}>
                <span className={`fbadge ${badge.tone}`} title={badge.title} aria-label={badge.title}>{badge.label}</span>
                <span className="fname">{displayDiffPath(file.path, turnDiff?.repoRoot)}</span>
                <span className="fops">{file.binary ? 'binary' : `+${file.added} −${file.deleted}`}</span>
              </div>
            )
          })}
        </div>
      ) : files.length === 0 ? (
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
  if (kind === 'skill') return `${ev.name ?? 'Skill'}${isInferredSkillLoad(ev) ? '（加载推断）' : ''}`
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

function errorEvidenceText(value: unknown): string {
  if (value == null) return 'Provider 未上报'
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  const limit = 8_000
  return text.length > limit ? `${text.slice(0, limit)}\n\n… 已截断（原始 ${text.length} 字符）` : text
}

export function TurnToolErrorDetails({
  errors,
  onOpen
}: {
  errors: OverviewToolError[]
  onOpen: (error: OverviewToolError) => void
}): ReactNode {
  return (
    <div className="turn-tool-errors" aria-label="本轮工具报错详情">
      {errors.map((error, index) => (
        <details className="turn-tool-error" key={`${error.result.id}:${index}`}>
          <summary title={error.message}>
            <strong><Icon name="x" />{error.tool}</strong>
            <span>{error.message}</span>
            <Icon name="chevronDown" className="turn-tool-error-chevron" />
          </summary>
          <div className="turn-tool-error-evidence">
            <div className="turn-tool-error-evidence-head">
              <span>调用证据</span>
              <button type="button" onClick={() => onOpen(error)}>定位到对话</button>
            </div>
            <div className="turn-tool-error-field">
              <span>输入</span>
              <pre>{errorEvidenceText(error.input)}</pre>
            </div>
            <div className="turn-tool-error-field">
              <span>输出</span>
              <pre>{errorEvidenceText(error.output)}</pre>
            </div>
            <div className="turn-tool-error-field is-error">
              <span>报错信息</span>
              <pre>{error.message}</pre>
            </div>
          </div>
        </details>
      ))}
    </div>
  )
}

function OverviewSessionSummary({ sessionId, compactions }: { sessionId: string | null; compactions: number }) {
  const [expanded, setExpanded] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [scopeDismissed, setScopeDismissed] = useState(false)
  const scopeId = useId()
  const fullId = useId()
  const shortId = sessionId && sessionId.length > 17 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-8)}` : sessionId
  const copy = OVERVIEW_SESSION_COPY

  return (
    <section className="panel-section overview-session-summary">
      <div className="overview-session-head">
        <h4>{copy.heading}</h4>
        <div className="overview-session-compact">
          <span>{copy.compact}</span>
          <span className="overview-session-scope" data-dismissed={scopeDismissed ? '' : undefined} onMouseEnter={() => setScopeDismissed(false)} onFocus={() => setScopeDismissed(false)} onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setScopeDismissed(true)
              event.stopPropagation()
            }
          }}>
            <button type="button" aria-label={copy.scopeLabel} aria-describedby={scopeId}><Icon name="info" /></button>
            <span id={scopeId} role="tooltip">{copy.scope}</span>
          </span>
          <strong className="overview-session-count">{compactions}</strong>
        </div>
      </div>
      <div className="overview-session-identity">
        <span>{copy.id}</span>
        {sessionId ? (
          <button type="button" className="overview-session-id-toggle" title={sessionId} aria-label={expanded ? copy.collapseId : copy.expandId} aria-expanded={expanded} aria-controls={fullId} onClick={() => setExpanded(!expanded)}>
            <code>{shortId}</code>
          </button>
        ) : <span className="overview-session-missing">{copy.missingId}</span>}
        <button type="button" className="overview-session-copy" disabled={!sessionId} aria-label={copy.copy} title={copy.copy} onClick={() => {
          if (sessionId) void window.scry.copyText(sessionId).then(() => setCopyStatus('copied')).catch(() => setCopyStatus('failed'))
        }}><Icon name={copyStatus === 'copied' ? 'check' : 'copy'} /></button>
      </div>
      <div id={fullId} className="overview-session-full-id" hidden={!expanded}><code>{sessionId}</code></div>
      {copyStatus !== 'idle' && <div className="overview-session-notice" role={copyStatus === 'failed' ? 'alert' : 'status'}>{copyStatus === 'copied' ? copy.copied : copy.copyFailed}</div>}
    </section>
  )
}

export interface OverviewPanelProps {
  turns: Turn[]
  sessionId?: string | null
  selected: TraceEvent | null
  usage: { cost: number | null; tin: number | null; tout: number | null; turns: number } | null
  stats: DbStats | null
  runtimeProvider?: RuntimeProvider
  gitDiff?: WorkspaceDiffResult | null
  busy?: boolean
  onSelect: (ev: TraceEvent) => void
  onOpenTurn?: (runId: string, ev?: TraceEvent | null, target?: 'turn' | 'event') => void
  onOpenSessionDiff?: (path?: string) => void
}

export function OverviewPanel(props: OverviewPanelProps) {
  const sessionId = props.sessionId ?? null
  const turns = useSampledTurns(props.turns, sessionId, props.busy ?? false)
  return <MemoOverviewPanelBody {...props} sessionId={sessionId} turns={turns} />
}

function OverviewPanelBody({
  turns,
  sessionId = null,
  selected,
  runtimeProvider,
  gitDiff,
  busy = false,
  onSelect,
  onOpenTurn,
  onOpenSessionDiff
}: OverviewPanelProps) {
  const [filesFolded, setFilesFolded] = useState(false)
  const [overviewDataTab, setOverviewDataTab] = useState<'turns' | 'session'>('turns')
  const [expandedTurnCallGroups, setExpandedTurnCallGroups] = useState<Set<string>>(() => new Set())
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
        <div className={`ctx-gauge ${ctx ? (ctx.pct >= 80 ? 'hot' : ctx.pct >= 50 ? 'warm' : '') : 'empty'}`} title={contextDescription}>
          <div
            className="ring"
            style={ctx ? ({ '--p': Math.min(ctx.pct, 100) } as CSSProperties) : undefined}
            aria-label={ctx ? `上下文占用 ${ctx.pct}%` : '暂无上下文占用数据'}
          >
            <span>{ctx ? `${ctx.pct}%` : '—'}</span>
          </div>
          <div className="ctx-copy">
            <div className="v">{ctx ? `${fmtTok(ctx.used)} / ${fmtTok(ctx.win)}` : '暂无上下文数据'}</div>
          </div>
        </div>
      )}

      {turns.length > 0 && (
        <section className={`overview-verdict ${vstate}`} aria-label="当前会话判词与尺度">
          <header className="overview-verdict-line">
            <div>
              <span className={`sdot ${vstate}`} />
              <strong>{judge}</strong>
            </div>
            <em>{calls.totalCalls} calls</em>
          </header>
          <div className="overview-metric-grid">
            <div className="overview-metric accent">
              <span>{billing.tokenFormulaLabel}</span>
              <strong>{billingTokenText}</strong>
            </div>
            <div
              className={`overview-metric ${cacheHit.rate == null ? 'unsupported' : ''}`}
              title={cacheHit.rate == null
                ? '没有完整的输入与缓存 Token 证据，无法计算命中率'
                : `缓存读取 Token ÷ 可缓存输入 Token；${cacheHit.knownResults}/${results.length} 轮可计算`}
            >
              <span>缓存命中率{cacheHit.missingResults > 0 ? ' · 部分' : ''}</span>
              <strong>{cacheHit.rate == null ? '—' : `${cacheHit.rate.toFixed(1)}%`}</strong>
            </div>
            <div
              className={`overview-metric ${isQoder ? (qoderCreditKnown ? 'accent' : 'unsupported') : cost.value == null ? 'unsupported' : ''}`}
              title={isQoder
                ? qoderCreditKnown ? `仅统计已观测到的主会话请求 Credit${qoderCreditPartial ? '，存在未覆盖请求或轮次' : ''}` : '当前会话没有可用的 Qoder Credit 证据'
                : cost.value == null ? OVERVIEW_COST_COPY.unavailable : OVERVIEW_COST_COPY.coverage(cost.known, results.length)}
            >
              <span>{isQoder ? 'Credit' : OVERVIEW_COST_COPY.label}</span>
              <strong>{isQoder
                ? qoderCreditKnown ? `${qoderCreditPartial ? '≥' : ''}${formatOverviewCredits(qoderCredits)}` : '—'
                : cost.value == null ? '—' : formatOverviewCost(cost.value)}</strong>
            </div>
          </div>
        </section>
      )}

      {turns.length > 0 && (
        <OverviewSessionSummary key={sessionId} sessionId={sessionId} compactions={compactions.length} />
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
              const timingAvailable = Boolean(
                row.timing.turnWall != null || row.timing.providerTiming?.totalMs != null || row.timing.providerTiming?.apiMs != null ||
                row.timing.apiMs != null || row.timing.totalCalls > 0
              )
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
                      {row.errors.length > 0 && (
                        <span className="turn-call-group error" title={`本轮 ${row.errors.length} 处工具报错，详情见下方`}>
                          <span className="turn-call-kind">报错</span>
                          <span className="turn-call-count">{row.errors.length}</span>
                        </span>
                      )}
                      {timingAvailable && (
                        <button
                          type="button"
                          className="turn-call-group turn-call-toggle timing"
                          title={timingExpanded ? '收起耗时明细' : '查看耗时来源与统计范围'}
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
                        kind: 'file', count: turnFileCount(row), expanded: fileExpanded,
                        controls: `turn-files-${row.turnNo}`,
                        onToggle: (event) => toggleTurnCallGroup(fileKey, event)
                      })}
                    </div>
                  </div>
                  {(row.errors.length > 0 || timingExpanded || interventionExpanded || mcpExpanded || skillExpanded || hooksExpanded || fileExpanded) && (
                    <div className="turn-call-detail-slot">
                      {row.errors.length > 0 && (
                        <TurnToolErrorDetails
                          errors={row.errors}
                          onOpen={(error) => {
                            if (onOpenTurn) onOpenTurn(row.runId, error.event, 'event')
                            else onSelect(error.event)
                          }}
                        />
                      )}
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
                        <div id={`turn-hooks-${row.turnNo}`}><HooksSummary summary={row.hooks} title="Hooks 明细" defaultExpanded /></div>
                      )}
                      {fileExpanded && (
                        <div id={`turn-files-${row.turnNo}`}>
                          <TurnFileFootprint
                            files={row.files}
                            preview={row.turnDiffPreview}
                            {...(row.turnDiff ? { turnDiff: row.turnDiff } : {})}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="psrc">每轮展示工具报错及其输入、输出、错误信息，并汇总结构化介入、MCP、Skill、子 Agent、Hook 与文件数量；Skill 含用户明确指定且成功读取技能文件的加载推断，不等于 Provider 原生 Skill 调用。介入仅统计结构化问答/权限请求。</div>
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
      {sessionInterventions.length > 0 && (
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
        <div className="panel-section danger-audit-section">
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
            <div className="dim pad2">尚未观测到 Skill 调用或加载证据</div>
          ) : (
            calls.skills.map((s) => (
              <button
                type="button"
                className="callrow"
                key={s.name}
                onClick={() => jumpTo((e) => logicalCallEvents.some((call) => call.kind === 'skill' && call.name === s.name && call.id === e.id && call.runId === e.runId))}
                title="点查看原始 Skill 调用或文件加载证据；加载推断不等于原生 Skill 调用"
              >
                <span className="ckind">
                  <Icon name="box" />
                </span>
                <span className="fname" title={s.name}>
                  {s.name}{logicalCallEvents.some((event) => event.name === s.name && isInferredSkillLoad(event)) ? '（含加载推断）' : ''}
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
                title={sessionNetTitle}
                onClick={() => onOpenSessionDiff()}
              >
                {sessionNetHeading}
                <span className="more">
                  {(sessionNetDiff?.files ?? sessionActivity.files).length} files · +{sessionNetDiff?.added ?? sessionActivity.added} −{sessionNetDiff?.deleted ?? sessionActivity.deleted}{' '}
                  <Icon name="chevronRight" />
                </span>
              </button>
            ) : (
              <>
                {sessionNetHeading}
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
            {sessionNetSource}
          </div>
        </div>
      )}

      {gitDiff !== undefined &&
        (() => {
          // P2 §8.4：工具足迹 vs 工作区 diff 对照——diff 里的文件，工具碰过标 check，没碰过标 alert
          const touched = new Set(structured.map((f) => f.path))
          return (
            <div className="panel-section">
              <h4>
                {workspaceDiffCopy.overviewHeading}
                <span className="more" role="status" data-evidence={gitDiff?.status ?? 'pending'} title={workspaceDiffCopy.detail(gitDiff)}>
                  {gitDiff?.status === 'captured' && diffFiles.length
                    ? workspaceDiffCopy.totals(diffFiles.length, diffAdd, diffDel)
                    : workspaceDiffCopy.label(gitDiff)}
                </span>
              </h4>
              {diffFiles.map((d) => (
                <div className="gdrow" key={d.path} title={d.path}>
                  <span className={`gd-mark ${touched.has(d.path) ? 'gd-add' : 'gd-del'}`}>
                    <Icon name={touched.has(d.path) ? 'check' : 'alert'} />
                  </span>
                  <span className="gd-path">{basename(d.path)}</span>
                  {d.binary ? (
                    <span className="dim">{workspaceDiffCopy.binary}</span>
                  ) : (
                    <>
                      <span className="gd-add">+{d.added}</span>
                      <span className="gd-del">−{d.deleted}</span>
                    </>
                  )}
                </div>
              ))}
              <div className="psrc">
                {workspaceDiffCopy.scope}
              </div>
            </div>
          )
        })()}

        </div>
      )}

      </div>
    </aside>
  )
}

const MemoOverviewPanelBody = memo(OverviewPanelBody)
