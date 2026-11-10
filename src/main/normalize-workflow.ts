// Claude Code dynamic-workflow task events -> `harness / workflow_activity` trace events.
//
// Identity is structural only: a task is a workflow when the provider says
// `task_type: 'local_workflow'`, when its tool_use_id is an observed `Workflow` tool_use,
// or when the event carries `workflow_progress`. Descriptions and prompt text never decide.
//
// The provider repeats the whole row snapshot on every progress event. Forwarding it as-is
// would grow the trace quadratically with agent count, so this module keeps the last row
// fingerprints per task and emits only the rows that changed (bounded per event).

import type { TraceEvent } from '../shared/trace.js'
import {
  WORKFLOW_ACTIVITY_STAGE,
  WORKFLOW_ROWS_PER_EVENT,
  WORKFLOW_SCRIPT_MAX_CHARS,
  WORKFLOW_TASK_TYPE,
  WORKFLOW_TOOL_NAME,
  boundedWorkflowText,
  readWorkflowWireRow,
  workflowCount,
  workflowRowKey,
  type WorkflowActivity,
  type WorkflowActivityKind,
  type WorkflowLaunchResult,
  type WorkflowRow,
  type WorkflowUsage
} from '../shared/claude-workflow.js'
import { base, stringValue, type NormalizeCtx } from './normalize-core.js'

/** The CLI caps a run at 1,000 agents; phases add a few more rows. */
const MAX_TRACKED_ROWS = 2_048
const MAX_TRACKED_TASKS = 64

interface WorkflowTaskState {
  toolUseId?: string
  seq: number
  rows: Map<string, string>
}

export interface WorkflowNormalizeState {
  toolUseIds: Set<string>
  tasks: Map<string, WorkflowTaskState>
}

export function cloneWorkflowNormalizeState(state: WorkflowNormalizeState): WorkflowNormalizeState {
  return {
    toolUseIds: new Set(state.toolUseIds),
    tasks: new Map([...state.tasks].map(([id, task]) => [id, { ...task, rows: new Map(task.rows) }]))
  }
}

function stateOf(ctx: NormalizeCtx): WorkflowNormalizeState {
  return ctx.workflow ??= { toolUseIds: new Set(), tasks: new Map() }
}

function trackTask(ctx: NormalizeCtx, taskId: string, toolUseId: string | undefined): WorkflowTaskState {
  const state = stateOf(ctx)
  let task = state.tasks.get(taskId)
  if (!task) {
    // Oldest-first eviction keeps a very long session bounded; an evicted task that
    // reports again restarts at seq 1 and the renderer flags the gap as partial.
    if (state.tasks.size >= MAX_TRACKED_TASKS) state.tasks.delete(state.tasks.keys().next().value as string)
    task = { seq: 0, rows: new Map() }
    state.tasks.set(taskId, task)
  }
  if (toolUseId && !task.toolUseId) task.toolUseId = toolUseId
  return task
}

/** `Workflow` tool_result: keep the structured launch receipt and alias task -> tool_use. */
export function workflowLaunchMetadata(
  ctx: NormalizeCtx,
  started: TraceEvent | undefined,
  toolUseId: string,
  outerResult: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (started?.tool !== WORKFLOW_TOOL_NAME || !ctx.workflow?.toolUseIds.has(toolUseId) || !outerResult) return undefined
  const workflow: WorkflowLaunchResult = {}
  const fields: Array<[keyof WorkflowLaunchResult, string, number]> = [
    ['status', 'status', 40], ['taskId', 'taskId', 120], ['runId', 'runId', 120],
    ['workflowName', 'workflowName', 200], ['summary', 'summary', 400],
    ['scriptPath', 'scriptPath', 1_000], ['transcriptDir', 'transcriptDir', 1_000], ['error', 'error', 400]
  ]
  for (const [key, wire, max] of fields) {
    const value = boundedWorkflowText(outerResult[wire], max)
    if (value) workflow[key] = value
  }
  if (Object.keys(workflow).length === 0) return undefined
  if (workflow.taskId) trackTask(ctx, workflow.taskId, toolUseId)
  return { source: 'provider_workflow_result', workflow }
}

function usageOf(value: unknown): WorkflowUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const usage: WorkflowUsage = {}
  const totalTokens = workflowCount(raw.total_tokens)
  const toolUses = workflowCount(raw.tool_uses)
  const durationMs = workflowCount(raw.duration_ms)
  if (totalTokens !== undefined) usage.totalTokens = totalTokens
  if (toolUses !== undefined) usage.toolUses = toolUses
  if (durationMs !== undefined) usage.durationMs = durationMs
  return Object.keys(usage).length > 0 ? usage : undefined
}

interface RowDelta {
  changed: WorkflowRow[]
  total: number
  unrecognized: number
  overflow: number
}

function rowDelta(task: WorkflowTaskState, snapshot: unknown[]): RowDelta {
  const changed: WorkflowRow[] = []
  let unrecognized = 0
  let overflow = 0
  let total = 0
  for (const wire of snapshot) {
    // Script log() lines are a known row type this view does not forward; older CLIs leave
    // them in the snapshot. They are neither progress rows nor an unknown shape.
    if (wire && typeof wire === 'object' && (wire as Record<string, unknown>).type === 'workflow_log') continue
    total += 1
    const row = readWorkflowWireRow(wire)
    if (!row) { unrecognized += 1; continue }
    const key = workflowRowKey(row)
    // A running agent refreshes lastProgressAt on every snapshot. That heartbeat alone is not
    // a row change, otherwise every snapshot would re-emit every running agent.
    const fingerprint = JSON.stringify(row.type === 'agent' ? { ...row, lastProgressAt: undefined } : row)
    if (task.rows.get(key) === fingerprint) continue
    if (!task.rows.has(key) && task.rows.size >= MAX_TRACKED_ROWS) { overflow += 1; continue }
    task.rows.set(key, fingerprint)
    changed.push(row)
  }
  return { changed, total, unrecognized, overflow }
}

function isWorkflowTask(message: Record<string, unknown>, ctx: NormalizeCtx, taskId: string | undefined): boolean {
  const state = ctx.workflow
  const toolUseId = stringValue(message.tool_use_id ?? message.toolUseId)
  if (message.task_type === WORKFLOW_TASK_TYPE || Array.isArray(message.workflow_progress)) return true
  if (!state) return false
  return Boolean((toolUseId && state.toolUseIds.has(toolUseId)) || (taskId && state.tasks.has(taskId)))
}

/**
 * Returns undefined when the message is not a workflow task event, so the caller falls
 * through to the Agent-task path. An empty array means "workflow, nothing to emit".
 */
export function normalizeWorkflowTaskMessage(
  message: Record<string, unknown>,
  ctx: NormalizeCtx,
  subtype: WorkflowActivityKind
): TraceEvent[] | undefined {
  const taskId = stringValue(message.task_id ?? message.taskId)
  if (!isWorkflowTask(message, ctx, taskId)) return undefined
  if (!taskId) return []
  const wireToolUseId = stringValue(message.tool_use_id ?? message.toolUseId)
  const task = trackTask(ctx, taskId, wireToolUseId)
  const patch = subtype === 'task_updated' && message.patch && typeof message.patch === 'object'
    ? message.patch as Record<string, unknown>
    : undefined
  const shared: Omit<WorkflowActivity, 'seq' | 'rows'> = { activity: subtype, taskId }
  const runId = stringValue(message.run_id)
  const workflowName = boundedWorkflowText(message.workflow_name, 200)
  const description = boundedWorkflowText(patch?.description ?? message.description, 400)
  const summary = boundedWorkflowText(message.summary, 400)
  const status = boundedWorkflowText(patch?.status ?? (subtype === 'task_notification' ? message.status : undefined), 40)
  const error = boundedWorkflowText(patch?.error, 400)
  const usage = usageOf(message.usage)
  if (runId) shared.runId = runId
  if (workflowName) shared.workflowName = workflowName
  if (description) shared.description = description
  if (summary) shared.summary = summary
  if (status) shared.status = status
  if (error) shared.error = error
  if (usage) shared.usage = usage
  if (subtype === 'task_started' && typeof message.prompt === 'string' && message.prompt.trim()) {
    shared.script = message.prompt.slice(0, WORKFLOW_SCRIPT_MAX_CHARS)
    if (message.prompt.length > WORKFLOW_SCRIPT_MAX_CHARS) shared.scriptTruncated = true
  }
  const wait = message.usage_limit_wait && typeof message.usage_limit_wait === 'object'
    ? workflowCount((message.usage_limit_wait as Record<string, unknown>).resetsAt)
    : undefined
  if (wait !== undefined) shared.usageLimitResetsAt = wait
  const omitted = workflowCount(message.workflow_progress_omitted)
  if (omitted) shared.rowsOmitted = omitted

  const snapshot = Array.isArray(message.workflow_progress) ? message.workflow_progress : undefined
  const delta = snapshot ? rowDelta(task, snapshot) : undefined
  if (delta) {
    shared.progressObserved = true
    shared.rowTotal = delta.total
    if (delta.unrecognized > 0) shared.rowsUnrecognized = delta.unrecognized
    // Rows beyond the tracking bound are dropped here, so they count as omitted rows.
    if (delta.overflow > 0) shared.rowsOmitted = (shared.rowsOmitted ?? 0) + delta.overflow
  }
  const chunks: WorkflowRow[][] = []
  for (let start = 0; start < (delta?.changed.length ?? 0); start += WORKFLOW_ROWS_PER_EVENT) {
    chunks.push(delta!.changed.slice(start, start + WORKFLOW_ROWS_PER_EVENT))
  }
  // A progress heartbeat whose rows did not change still refreshes usage and liveness.
  if (chunks.length === 0) chunks.push([])
  return chunks.map((rows) => {
    task.seq += 1
    const input: WorkflowActivity = { ...shared, seq: task.seq, ...(rows.length > 0 ? { rows } : {}) }
    return base(ctx, {
      kind: 'harness',
      stage: WORKFLOW_ACTIVITY_STAGE,
      tool: WORKFLOW_TOOL_NAME,
      ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
      input,
      runtimeMetadata: { source: `provider_${subtype}`, taskId }
    })
  })
}
