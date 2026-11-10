// Claude Code dynamic-workflow observation contract (main normalizer -> trace -> renderer).
//
// Evidence source: the Claude Code CLI attaches `workflow_progress` rows to
// `system/task_progress` for `local_workflow` tasks. The field is NOT part of the public
// Agent SDK types (read from the CLI bundles of 2.1.251, which SDK 0.3.251 ships, and
// 2.1.322; no real workflow run was captured), so everything derived from it is provider
// observation that may be absent, withheld (bundled workflows redact titles and prompts)
// or reshaped by a CLI update. Absence must surface as `unavailable`, never as zero rows.

export const WORKFLOW_ACTIVITY_STAGE = 'workflow_activity'
export const WORKFLOW_TOOL_NAME = 'Workflow'
export const WORKFLOW_TASK_TYPE = 'local_workflow'

/** One event carries at most this many changed rows; larger deltas are chunked. */
export const WORKFLOW_ROWS_PER_EVENT = 128
export const WORKFLOW_SCRIPT_MAX_CHARS = 60_000
export const WORKFLOW_LABEL_MAX_CHARS = 200
export const WORKFLOW_PREVIEW_MAX_CHARS = 400

export type WorkflowActivityKind = 'task_started' | 'task_progress' | 'task_updated' | 'task_notification'

/** Provider wire state, kept verbatim; display status is derived in the renderer. */
export type WorkflowAgentWireState = 'start' | 'progress' | 'done' | 'error'

export interface WorkflowPhaseRow {
  type: 'phase'
  index: number
  title?: string
  kind?: string
}

export interface WorkflowAgentRow {
  type: 'agent'
  index: number
  state: WorkflowAgentWireState
  label?: string
  phaseIndex?: number
  phaseTitle?: string
  agentId?: string
  agentType?: string
  isolation?: string
  model?: string
  fallbackModel?: string
  attempt?: number
  lastAttemptReason?: string
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  resultPreview?: string
  error?: string
  cached?: boolean
  skipped?: boolean
  blocked?: boolean
  /** Provider settled this row because the whole run ended, not because the agent finished. */
  endedWithRun?: boolean
  queuedAt?: number
  startedAt?: number
  lastProgressAt?: number
  tokens?: number
  toolCalls?: number
  durationMs?: number
}

export type WorkflowRow = WorkflowPhaseRow | WorkflowAgentRow

export interface WorkflowUsage {
  totalTokens?: number
  toolUses?: number
  durationMs?: number
}

/** `TraceEvent.input` of a `harness / workflow_activity` event. */
export interface WorkflowActivity {
  activity: WorkflowActivityKind
  taskId: string
  /** Per-task counter assigned by the normalizer; a gap means earlier events are not loaded. */
  seq: number
  runId?: string
  workflowName?: string
  description?: string
  summary?: string
  /** `task_started.prompt`: the script text, empty when the provider withholds it. */
  script?: string
  scriptTruncated?: boolean
  /** Provider task status (`task_updated.patch.status` / `task_notification.status`). */
  status?: string
  error?: string
  usage?: WorkflowUsage
  /** Rows that changed since the previous event of this task (delta, not a snapshot). */
  rows?: WorkflowRow[]
  /** Row count of the provider snapshot this delta was cut from. */
  rowTotal?: number
  /** Rows the provider dropped from a size-capped snapshot. */
  rowsOmitted?: number
  /** Rows this build could not interpret; they are counted, not guessed. */
  rowsUnrecognized?: number
  /** True when the provider sent `workflow_progress` on this event at all. */
  progressObserved?: boolean
  usageLimitResetsAt?: number
}

/** Structured `Workflow` tool result (`tool_use_result`), kept on the tool_result event. */
export interface WorkflowLaunchResult {
  status?: string
  taskId?: string
  runId?: string
  workflowName?: string
  summary?: string
  scriptPath?: string
  transcriptDir?: string
  error?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function index(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

const AGENT_STATES: readonly WorkflowAgentWireState[] = ['start', 'progress', 'done', 'error']

/** Strict wire-row reader. Unknown shapes return undefined so the caller can count them. */
export function readWorkflowWireRow(value: unknown): WorkflowRow | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const rowIndex = index(raw.index)
  if (rowIndex === undefined) return undefined
  if (raw.type === 'workflow_phase') {
    const title = text(raw.title, WORKFLOW_LABEL_MAX_CHARS)
    const kind = text(raw.kind, 40)
    return { type: 'phase', index: rowIndex, ...(title ? { title } : {}), ...(kind ? { kind } : {}) }
  }
  if (raw.type !== 'workflow_agent') return undefined
  const state = AGENT_STATES.find((candidate) => candidate === raw.state)
  if (!state) return undefined
  const row: WorkflowAgentRow = { type: 'agent', index: rowIndex, state }
  const strings: Array<[keyof WorkflowAgentRow, string, number]> = [
    ['label', 'label', WORKFLOW_LABEL_MAX_CHARS], ['phaseTitle', 'phaseTitle', WORKFLOW_LABEL_MAX_CHARS],
    ['agentId', 'agentId', 80], ['agentType', 'agentType', 80], ['isolation', 'isolation', 40],
    ['model', 'model', 120], ['fallbackModel', 'fallbackModel', 120],
    ['lastAttemptReason', 'lastAttemptReason', 80], ['lastToolName', 'lastToolName', 120],
    ['lastToolSummary', 'lastToolSummary', WORKFLOW_PREVIEW_MAX_CHARS],
    ['promptPreview', 'promptPreview', WORKFLOW_PREVIEW_MAX_CHARS],
    ['resultPreview', 'resultPreview', WORKFLOW_PREVIEW_MAX_CHARS],
    ['error', 'error', WORKFLOW_PREVIEW_MAX_CHARS]
  ]
  const target = row as unknown as Record<string, unknown>
  for (const [key, wire, max] of strings) {
    const read = text(raw[wire], max)
    if (read) target[key] = read
  }
  for (const key of ['queuedAt', 'startedAt', 'lastProgressAt', 'tokens', 'toolCalls', 'durationMs', 'attempt'] as const) {
    const read = count(raw[key])
    if (read !== undefined) target[key] = read
  }
  const phaseIndex = index(raw.phaseIndex)
  if (phaseIndex !== undefined) row.phaseIndex = phaseIndex
  for (const key of ['cached', 'skipped', 'blocked', 'endedWithRun'] as const) {
    if (raw[key] === true) target[key] = true
  }
  return row
}

export function workflowRowKey(row: WorkflowRow): string {
  return `${row.type}:${row.index}`
}

function readStoredRow(value: unknown): WorkflowRow | undefined {
  const raw = record(value)
  if (!raw || index(raw.index) === undefined) return undefined
  if (raw.type === 'phase') return raw as unknown as WorkflowPhaseRow
  if (raw.type === 'agent' && AGENT_STATES.includes(raw.state as WorkflowAgentWireState)) {
    return raw as unknown as WorkflowAgentRow
  }
  return undefined
}

const ACTIVITIES: readonly WorkflowActivityKind[] = ['task_started', 'task_progress', 'task_updated', 'task_notification']

/** Reads an archived/live activity payload; older or foreign shapes return undefined. */
export function readWorkflowActivity(input: unknown): WorkflowActivity | undefined {
  const raw = record(input)
  if (!raw) return undefined
  const activity = ACTIVITIES.find((candidate) => candidate === raw.activity)
  if (!activity || typeof raw.taskId !== 'string' || !raw.taskId) return undefined
  const seq = index(raw.seq)
  if (seq === undefined) return undefined
  const rows = Array.isArray(raw.rows)
    ? raw.rows.flatMap((row) => { const read = readStoredRow(row); return read ? [read] : [] })
    : undefined
  return { ...(raw as unknown as WorkflowActivity), activity, taskId: raw.taskId, seq, ...(rows ? { rows } : {}) }
}

export function readWorkflowLaunchResult(metadata: unknown): WorkflowLaunchResult | undefined {
  const workflow = record(record(metadata)?.workflow)
  return workflow ? workflow as WorkflowLaunchResult : undefined
}

export { text as boundedWorkflowText, count as workflowCount }
