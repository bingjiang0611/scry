// Folds `workflow_activity` trace events into one projection per Claude Code workflow run.
// Pure and renderer-side: it only reads events main already validated and never infers a
// terminal state, an agent count or a usage number the provider did not report.

import type { TraceEvent } from '@shared/trace'
import {
  WORKFLOW_ACTIVITY_STAGE,
  WORKFLOW_TOOL_NAME,
  readWorkflowActivity,
  readWorkflowLaunchResult,
  workflowRowKey,
  type WorkflowAgentRow,
  type WorkflowLaunchResult,
  type WorkflowPhaseRow,
  type WorkflowUsage
} from '@shared/claude-workflow'
import type { Turn } from './format-types'

export type WorkflowRunStatus = 'launching' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'unknown'
export type WorkflowStatusSource =
  | 'tool_use' | 'launch_error' | 'task_started' | 'task_updated' | 'task_notification' | 'missing_terminal'

export type WorkflowAgentStatus =
  | 'queued' | 'running' | 'done' | 'cached' | 'failed' | 'skipped' | 'blocked' | 'unsettled'

export interface WorkflowAgentView {
  row: WorkflowAgentRow
  status: WorkflowAgentStatus
}

export interface WorkflowPhaseView {
  key: string
  index?: number
  title: string
  /** False when only agent rows referenced this phase and no phase row was observed. */
  declared: boolean
  agents: WorkflowAgentView[]
  settled: number
  failed: number
  running: number
  models: string[]
  /** `unsettled`: the run ended while agents of this phase had no reported outcome. */
  status: 'pending' | 'running' | 'done' | 'failed' | 'unsettled'
}

export interface WorkflowLogEntry {
  id: string
  at?: string
  actor: string
  message: string
  tone: 'info' | 'ok' | 'warn' | 'error'
}

export interface WorkflowScript {
  text: string
  source: 'tool_input' | 'task_started'
  truncated: boolean
  /** 1-based line of each `phase('<title>')` literal, matched by exact title text. */
  phaseLines: Record<string, number>
}

export interface WorkflowRun {
  id: string
  turnRunId: string
  toolUseId?: string
  taskId?: string
  providerRunId?: string
  name?: string
  description?: string
  script?: WorkflowScript
  /** Saved-workflow name or script path when the tool call did not inline a script. */
  scriptRef?: string
  launch?: WorkflowLaunchResult
  status: WorkflowRunStatus
  statusSource: WorkflowStatusSource
  providerStatus?: string
  summary?: string
  error?: string
  /** `observed`: rows arrived. `unavailable`: task events arrived without rows. */
  progress: 'observed' | 'unavailable' | 'pending'
  /** Earlier events of this task are not in the loaded history; counts below are a lower bound. */
  partial: boolean
  rowsOmitted: number
  rowsUnrecognized: number
  phases: WorkflowPhaseView[]
  agentCount: number
  usage?: WorkflowUsage
  usageLimitResetsAt?: number
  startedAt?: string
  updatedAt?: string
  endedAt?: string
  log: WorkflowLogEntry[]
  logDropped: number
}

export interface DeriveWorkflowRunsOptions {
  busy: boolean
}

const MAX_LOG_ENTRIES = 300
const UNGROUPED = 'ungrouped'
const TERMINAL: readonly WorkflowRunStatus[] = ['completed', 'failed', 'stopped']

interface Accumulator {
  run: WorkflowRun
  turn: Turn
  phaseRows: Map<number, WorkflowPhaseRow>
  agentRows: Map<string, WorkflowAgentRow>
  agentStatus: Map<string, WorkflowAgentStatus>
  lastSeq: number
  taskEvents: number
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function scriptOf(text: string, source: WorkflowScript['source'], truncated: boolean): WorkflowScript {
  const phaseLines: Record<string, number> = {}
  text.split('\n').forEach((line, index) => {
    const match = /\bphase\(\s*(['"`])(.+?)\1/.exec(line)
    if (match && phaseLines[match[2]] === undefined) phaseLines[match[2]] = index + 1
  })
  return { text, source, truncated, phaseLines }
}

/** Display status of one agent row while its run is still live. */
export function workflowAgentStatus(row: WorkflowAgentRow): WorkflowAgentStatus {
  if (row.state === 'error') return row.skipped ? 'skipped' : row.blocked ? 'blocked' : 'failed'
  if (row.state === 'done') return row.cached ? 'cached' : 'done'
  if (row.state === 'progress') return 'running'
  return row.startedAt !== undefined ? 'running' : 'queued'
}

const SETTLED: readonly WorkflowAgentStatus[] = ['done', 'cached', 'failed', 'skipped', 'blocked']
const FAILED: readonly WorkflowAgentStatus[] = ['failed', 'blocked']

function providerRunStatus(status: string | undefined): WorkflowRunStatus | undefined {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status && ['stopped', 'killed', 'cancelled', 'canceled', 'interrupted'].includes(status)) return 'stopped'
  if (status === 'paused') return 'paused'
  if (status === 'running' || status === 'pending') return 'running'
  return undefined
}

function pushLog(acc: Accumulator, event: TraceEvent, entry: Omit<WorkflowLogEntry, 'id' | 'at'>): void {
  const { run } = acc
  run.log.push({ id: `${event.id}:${run.log.length + run.logDropped}`, ...(event.ts ? { at: event.ts } : {}), ...entry })
  if (run.log.length > MAX_LOG_ENTRIES) {
    run.logDropped += run.log.length - MAX_LOG_ENTRIES
    run.log.splice(0, run.log.length - MAX_LOG_ENTRIES)
  }
}

function agentActor(row: WorkflowAgentRow): string {
  return row.model ?? row.agentType ?? 'agent'
}

function agentName(row: WorkflowAgentRow): string {
  return row.label ?? `agent #${row.index}`
}

function logAgentTransition(acc: Accumulator, event: TraceEvent, row: WorkflowAgentRow, status: WorkflowAgentStatus): void {
  const name = agentName(row)
  const where = row.phaseTitle ? `${row.phaseTitle} · ` : ''
  const attempt = row.attempt && row.attempt > 1 ? ` · 第 ${row.attempt} 次尝试` : ''
  const messages: Record<WorkflowAgentStatus, [string, WorkflowLogEntry['tone']]> = {
    queued: [`${where}${name} 排队`, 'info'],
    running: [`${where}${name} 开始${attempt}`, 'info'],
    done: [`${where}${name} 完成${row.resultPreview ? ` · ${row.resultPreview}` : ''}`, 'ok'],
    cached: [`${where}${name} 复用已保存结果`, 'ok'],
    failed: [`${where}${name} 失败${row.error ? ` · ${row.error}` : ''}`, 'error'],
    skipped: [`${where}${name} 被用户跳过`, 'warn'],
    blocked: [`${where}${name} 被拦截${row.error ? ` · ${row.error}` : ''}`, 'error'],
    unsettled: [`${where}${name} 未上报终态`, 'warn']
  }
  const [message, tone] = messages[status]
  pushLog(acc, event, { actor: agentActor(row), message, tone })
}

function createRun(turn: Turn, id: string, event: TraceEvent): Accumulator {
  return {
    turn,
    phaseRows: new Map(),
    agentRows: new Map(),
    agentStatus: new Map(),
    lastSeq: 0,
    taskEvents: 0,
    run: {
      id, turnRunId: turn.runId, status: 'launching', statusSource: 'tool_use', progress: 'pending', partial: false,
      rowsOmitted: 0, rowsUnrecognized: 0, phases: [], agentCount: 0, log: [], logDropped: 0,
      ...(event.ts ? { startedAt: event.ts, updatedAt: event.ts } : {})
    }
  }
}

function applyToolUse(acc: Accumulator, event: TraceEvent): void {
  const input = record(event.input)
  const { run } = acc
  run.toolUseId = event.toolUseId
  if (typeof input.script === 'string' && input.script.trim()) run.script = scriptOf(input.script, 'tool_input', false)
  const ref = typeof input.name === 'string' && input.name ? input.name
    : typeof input.scriptPath === 'string' && input.scriptPath ? input.scriptPath : undefined
  if (ref) run.scriptRef = ref
  pushLog(acc, event, { actor: '主会话', message: `调用 Workflow 工具${ref ? ` · ${ref}` : ''}`, tone: 'info' })
}

function applyToolResult(acc: Accumulator, event: TraceEvent): void {
  const { run } = acc
  const launch = readWorkflowLaunchResult(event.runtimeMetadata)
  if (launch) {
    run.launch = launch
    run.taskId ??= launch.taskId
    run.providerRunId ??= launch.runId
    run.name ??= launch.workflowName
  }
  if (event.isError || launch?.error) {
    run.status = 'failed'
    run.statusSource = 'launch_error'
    run.error = launch?.error ?? event.output?.slice(0, 400)
    pushLog(acc, event, { actor: 'runtime', message: `启动失败${run.error ? ` · ${run.error}` : ''}`, tone: 'error' })
  } else {
    pushLog(acc, event, { actor: 'runtime', message: `已在后台启动${launch?.runId ? ` · run ${launch.runId}` : ''}`, tone: 'info' })
  }
}

function applyActivity(acc: Accumulator, event: TraceEvent): void {
  const activity = readWorkflowActivity(event.input)
  if (!activity) return
  const { run } = acc
  acc.taskEvents += 1
  // seq is assigned per task by main; a first event above 1 or a jump means lost history.
  if (activity.seq !== acc.lastSeq + 1) run.partial = true
  acc.lastSeq = Math.max(acc.lastSeq, activity.seq)
  run.taskId ??= activity.taskId
  run.toolUseId ??= event.toolUseId
  run.providerRunId ??= activity.runId
  run.name = activity.workflowName ?? run.name
  if (activity.description) run.description = activity.description
  if (activity.usage) run.usage = { ...run.usage, ...activity.usage }
  if (event.ts) { run.updatedAt = event.ts; run.startedAt ??= event.ts }
  if (activity.script && !run.script) run.script = scriptOf(activity.script, 'task_started', activity.scriptTruncated === true)
  if (activity.progressObserved) run.progress = 'observed'
  run.rowsOmitted = Math.max(run.rowsOmitted, activity.rowsOmitted ?? 0)
  run.rowsUnrecognized = Math.max(run.rowsUnrecognized, activity.rowsUnrecognized ?? 0)
  run.usageLimitResetsAt = activity.usageLimitResetsAt

  for (const row of activity.rows ?? []) {
    if (row.type === 'phase') {
      if (!acc.phaseRows.has(row.index)) {
        pushLog(acc, event, { actor: 'runtime', message: `阶段 ${row.title ?? `#${row.index}`} 已声明`, tone: 'info' })
      }
      acc.phaseRows.set(row.index, row)
      continue
    }
    const key = workflowRowKey(row)
    const status = workflowAgentStatus(row)
    if (acc.agentStatus.get(key) !== status) logAgentTransition(acc, event, row, status)
    acc.agentRows.set(key, row)
    acc.agentStatus.set(key, status)
  }

  if (activity.activity === 'task_started') {
    if (!TERMINAL.includes(run.status)) { run.status = 'running'; run.statusSource = 'task_started' }
    pushLog(acc, event, { actor: 'runtime', message: `workflow ${run.name ?? ''} 开始运行`.replace(/\s+/g, ' '), tone: 'info' })
    return
  }
  const status = providerRunStatus(activity.status)
  if (activity.activity === 'task_progress') {
    if (run.status === 'launching') { run.status = 'running'; run.statusSource = 'task_started' }
    return
  }
  if (activity.status) run.providerStatus = activity.status
  if (activity.error) run.error = activity.error
  if (activity.summary) run.summary = activity.summary
  if (!status) return
  // A terminal notification is authoritative; a later non-terminal patch cannot reopen it.
  if (TERMINAL.includes(run.status) && run.statusSource === 'task_notification' && activity.activity !== 'task_notification') return
  run.status = status
  run.statusSource = activity.activity === 'task_notification' ? 'task_notification' : 'task_updated'
  if (TERMINAL.includes(status) && event.ts) run.endedAt = event.ts
  const tone: WorkflowLogEntry['tone'] = status === 'completed' ? 'ok' : status === 'failed' ? 'error' : status === 'stopped' ? 'warn' : 'info'
  const label: Record<WorkflowRunStatus, string> = {
    launching: '启动中', running: '继续运行', paused: '已暂停', completed: '运行完成', failed: '运行失败', stopped: '已停止', unknown: '状态未知'
  }
  pushLog(acc, event, { actor: 'runtime', message: `${label[status]}${activity.summary ? ` · ${activity.summary}` : ''}`, tone })
}

function finish(acc: Accumulator, busy: boolean, lastTurn: Turn | undefined): WorkflowRun {
  const { run } = acc
  const live = !acc.turn.done || (busy && acc.turn === lastTurn)
  if (!TERMINAL.includes(run.status) && !live) {
    // The owning turn ended without a provider terminal event: do not guess the outcome.
    run.status = 'unknown'
    run.statusSource = 'missing_terminal'
  }
  if (run.progress === 'pending' && acc.taskEvents > 0) run.progress = 'unavailable'
  const runEnded = TERMINAL.includes(run.status) || run.status === 'unknown'
  const groups = new Map<string, WorkflowPhaseView>()
  const group = (key: string, index: number | undefined, title: string, declared: boolean): WorkflowPhaseView => {
    let phase = groups.get(key)
    if (!phase) {
      phase = { key, ...(index !== undefined ? { index } : {}), title, declared, agents: [], settled: 0, failed: 0, running: 0, models: [], status: 'pending' }
      groups.set(key, phase)
    }
    return phase
  }
  for (const row of [...acc.phaseRows.values()].sort((left, right) => left.index - right.index)) {
    group(`phase:${row.index}`, row.index, row.title ?? `phase ${row.index}`, true)
  }
  for (const row of [...acc.agentRows.values()].sort((left, right) => left.index - right.index)) {
    const phase = row.phaseIndex === undefined
      ? group(UNGROUPED, undefined, '未分组', false)
      : group(`phase:${row.phaseIndex}`, row.phaseIndex, row.phaseTitle ?? `phase ${row.phaseIndex}`, false)
    let status = workflowAgentStatus(row)
    if (runEnded && !SETTLED.includes(status)) status = 'unsettled'
    phase.agents.push({ row, status })
    if (SETTLED.includes(status)) phase.settled += 1
    if (FAILED.includes(status)) phase.failed += 1
    if (status === 'running') phase.running += 1
    const model = row.fallbackModel ?? row.model
    if (model && !phase.models.includes(model)) phase.models.push(model)
  }
  for (const phase of groups.values()) {
    phase.status = phase.agents.length === 0 ? 'pending'
      : phase.settled < phase.agents.length ? (runEnded ? 'unsettled' : 'running')
        : phase.failed > 0 ? 'failed' : 'done'
  }
  run.phases = [...groups.values()]
  run.agentCount = acc.agentRows.size
  return run
}

/** Workflow runs observed in the loaded turns, oldest first. */
export function deriveWorkflowRuns(turns: readonly Turn[], options: DeriveWorkflowRunsOptions): WorkflowRun[] {
  const byTool = new Map<string, Accumulator>()
  const byTask = new Map<string, Accumulator>()
  const order: Accumulator[] = []
  const toolKey = (turn: Turn, toolUseId: string): string => `${turn.runId}\u0000${toolUseId}`
  for (const turn of turns) {
    for (const event of turn.items) {
      if (event.tool !== WORKFLOW_TOOL_NAME) continue
      if (event.kind === 'tool' && event.toolUseId) {
        const key = toolKey(turn, event.toolUseId)
        let acc = byTool.get(key)
        if (event.stage !== 'tool_result') {
          if (acc) continue
          acc = createRun(turn, key, event)
          byTool.set(key, acc)
          order.push(acc)
          applyToolUse(acc, event)
        } else if (acc) {
          applyToolResult(acc, event)
          if (acc.run.taskId) byTask.set(acc.run.taskId, acc)
        }
        continue
      }
      if (event.kind !== 'harness' || event.stage !== WORKFLOW_ACTIVITY_STAGE) continue
      const taskId = readWorkflowActivity(event.input)?.taskId
      if (!taskId) continue
      let acc = byTask.get(taskId) ?? (event.toolUseId ? byTool.get(toolKey(turn, event.toolUseId)) : undefined)
      if (!acc) {
        // Task events without an observed tool call (resumed session, trimmed history).
        acc = createRun(turn, `task:${taskId}`, event)
        order.push(acc)
      }
      byTask.set(taskId, acc)
      applyActivity(acc, event)
    }
  }
  const lastTurn = turns.at(-1)
  return order.map((acc) => finish(acc, options.busy, lastTurn))
}
