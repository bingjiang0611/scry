// Synthetic Claude Code workflow wire messages for tests and the UI smoke fixture.
// Shapes follow what CLI 2.1.322 emits on the SDK stream (`system/task_*` with
// `workflow_progress`); nothing here was captured from a real account or billed run.

export const WORKFLOW_FIXTURE_SCRIPT = `export const meta = {
  name: 'audit-routes',
  description: 'Audit route handlers, patch findings, verify the patches',
  phases: [{ title: 'scan' }, { title: 'edit' }, { title: 'verify' }],
}

phase('scan')
const audits = await pipeline(files, file =>
  agent(\`Audit \${file} for missing auth checks.\`, { label: file, model: 'haiku' }),
)

phase('edit')
const patches = await parallel(audits.filter(Boolean).map(finding => () =>
  agent(\`Patch \${finding.file}.\`, { label: finding.file, isolation: 'worktree' }),
))

phase('verify')
const review = await agent('Cross-check every patch against the findings.', { label: 'review' })

return { verified: review }
`

type Wire = Record<string, unknown>

export interface WorkflowFixtureOptions {
  taskId?: string
  toolUseId?: string
  /** Stop after this many progress snapshots; omit for the full run with a terminal event. */
  progressSteps?: number
  terminalStatus?: 'completed' | 'failed' | 'stopped'
}

const PHASES = [
  { type: 'workflow_phase', index: 1, title: 'scan' },
  { type: 'workflow_phase', index: 2, title: 'edit' },
  { type: 'workflow_phase', index: 3, title: 'verify' }
]

function agent(index: number, phaseIndex: number, label: string, model: string, patch: Wire): Wire {
  return {
    type: 'workflow_agent', index, label, phaseIndex, phaseTitle: PHASES[phaseIndex - 1].title, model,
    queuedAt: 1_000 + index, promptPreview: `prompt for ${label}`, lastProgressAt: 2_000 + index, ...patch
  }
}

const SCAN_FILES = ['auth.ts', 'users.ts', 'billing.ts']
const EDIT_FILES = ['auth.ts', 'billing.ts']

function scan(state: 'start' | 'progress' | 'done'): Wire[] {
  return SCAN_FILES.map((file, offset) => agent(offset + 1, 1, file, 'claude-haiku-4-5', {
    state,
    ...(state !== 'start' ? { startedAt: 1_100 + offset, agentId: `a-scan-${offset}`, lastToolName: 'Read', tokens: 900 + offset, toolCalls: 2 } : {}),
    ...(state === 'done' ? { durationMs: 4_200, resultPreview: `${file}: 1 finding`, tokens: 2_400 + offset, toolCalls: 5 } : {})
  }))
}

function edit(state: 'start' | 'progress' | 'done'): Wire[] {
  return EDIT_FILES.map((file, offset) => agent(offset + 4, 2, file, 'claude-sonnet-4-5', {
    state, isolation: 'worktree',
    ...(state !== 'start' ? { startedAt: 3_100 + offset, agentId: `a-edit-${offset}`, lastToolName: 'Edit', tokens: 3_000, toolCalls: 4 } : {}),
    // The second edit agent fails: an error row must stay visible, not be folded into "done".
    ...(state === 'done' && offset === 0 ? { durationMs: 9_000, resultPreview: 'patched', tokens: 7_500, toolCalls: 9 } : {}),
    ...(state === 'done' && offset === 1 ? { state: 'error', error: 'stalled — no progress for 600s', attempt: 2, lastAttemptReason: 'stalled', durationMs: 12_000, tokens: 5_100, toolCalls: 6 } : {})
  }))
}

function verify(state: 'start' | 'progress' | 'done'): Wire[] {
  return [agent(6, 3, 'review', 'claude-sonnet-4-5', {
    state,
    ...(state !== 'start' ? { startedAt: 5_100, agentId: 'a-review', lastToolName: 'Bash', tokens: 1_800, toolCalls: 3 } : {}),
    ...(state === 'done' ? { durationMs: 6_000, resultPreview: '1 patch verified, 1 unverified', tokens: 4_000, toolCalls: 7 } : {})
  })]
}

/** Full provider snapshots in order; every snapshot repeats all earlier rows. */
export const WORKFLOW_FIXTURE_SNAPSHOTS: Wire[][] = [
  [...PHASES, ...scan('start')],
  [...PHASES, ...scan('progress')],
  [...PHASES, ...scan('done'), ...edit('start')],
  [...PHASES, ...scan('done'), ...edit('progress')],
  [...PHASES, ...scan('done'), ...edit('done'), ...verify('progress')],
  [...PHASES, ...scan('done'), ...edit('done'), ...verify('done')]
]

export function workflowFixtureMessages(options: WorkflowFixtureOptions = {}): Wire[] {
  const taskId = options.taskId ?? 'wtask-1'
  const toolUseId = options.toolUseId ?? 'toolu_workflow_1'
  const steps = options.progressSteps ?? WORKFLOW_FIXTURE_SNAPSHOTS.length
  const messages: Wire[] = [
    {
      type: 'assistant',
      message: { id: 'msg-wf', content: [{ type: 'tool_use', id: toolUseId, name: 'Workflow', input: { script: WORKFLOW_FIXTURE_SCRIPT } }] }
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Workflow launched in background' }] },
      tool_use_result: {
        status: 'async_launched', taskId, taskType: 'local_workflow', workflowName: 'audit-routes', runId: 'wf_run_1',
        scriptPath: '/tmp/fixture/.claude/projects/p/session/workflows/audit-routes.js',
        transcriptDir: '/tmp/fixture/.claude/projects/p/session/subagents'
      }
    },
    {
      type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, run_id: 'wf_run_1',
      task_type: 'local_workflow', workflow_name: 'audit-routes',
      description: 'Audit route handlers, patch findings, verify the patches', prompt: WORKFLOW_FIXTURE_SCRIPT
    }
  ]
  WORKFLOW_FIXTURE_SNAPSHOTS.slice(0, steps).forEach((snapshot, step) => {
    messages.push({
      type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolUseId, run_id: 'wf_run_1',
      description: 'audit-routes', last_tool_name: 'Read',
      usage: { total_tokens: 3_000 * (step + 1), tool_uses: 4 * (step + 1), duration_ms: 5_000 * (step + 1) },
      workflow_progress: snapshot
    })
  })
  if (options.progressSteps === undefined) {
    messages.push({
      type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId,
      status: options.terminalStatus ?? 'completed', output_file: '/tmp/fixture/tasks/wtask-1.output',
      summary: 'Dynamic workflow "audit-routes" completed',
      usage: { total_tokens: 26_600, tool_uses: 32, duration_ms: 31_000 }
    })
  }
  return messages
}

/**
 * A large fan-out run: `agentCount` agents across two phases, delivered as `snapshots`
 * full provider snapshots so the normalizer sees the same delta pattern as a real stream.
 * Used to check the caps (128 rows per event, 2,048 rows, 48 chips) instead of trusting them.
 */
export function workflowFixtureLargeMessages({ agentCount, snapshots = 6 }: {
  agentCount: number
  snapshots?: number
}): Wire[] {
  const taskId = 'wtask-large'
  const toolUseId = 'toolu_workflow_large'
  const phases = [
    { type: 'workflow_phase', index: 1, title: 'scan' },
    { type: 'workflow_phase', index: 2, title: 'fan' }
  ]
  const rows = (settled: number): Wire[] => Array.from({ length: agentCount }, (_, index) => agent(
    index + 1, (index % 2) + 1, `file-${index}.ts`, 'claude-haiku-4-5',
    index < settled
      ? { state: 'done', startedAt: 1_100 + index, agentId: `a-${index}`, tokens: 1_200, toolCalls: 3, durationMs: 4_000 }
      : { state: 'progress', startedAt: 1_100 + index, agentId: `a-${index}`, lastToolName: 'Read', tokens: 900, toolCalls: 2 }
  ))
  const messages: Wire[] = [
    { type: 'assistant', message: { id: 'msg-large', content: [{ type: 'tool_use', id: toolUseId, name: 'Workflow', input: { script: WORKFLOW_FIXTURE_SCRIPT } }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Workflow launched in background' }] },
      tool_use_result: { status: 'async_launched', taskId, taskType: 'local_workflow', workflowName: 'large-fan' }
    },
    {
      type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, run_id: 'wf_run_large',
      task_type: 'local_workflow', workflow_name: 'large-fan', description: 'large fan-out', prompt: WORKFLOW_FIXTURE_SCRIPT
    }
  ]
  for (let step = 0; step < snapshots; step++) {
    const settled = Math.round((agentCount * step) / snapshots)
    messages.push({
      type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolUseId, run_id: 'wf_run_large',
      description: 'large-fan', last_tool_name: 'Read',
      usage: { total_tokens: 12_000 * (step + 1), tool_uses: 40 * (step + 1), duration_ms: 30_000 * (step + 1) },
      workflow_progress: [...phases, ...rows(settled)]
    })
  }
  messages.push({
    type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId,
    status: 'completed', output_file: '/tmp/fixture/tasks/wtask-large.output', summary: 'Dynamic workflow "large-fan" completed',
    usage: { total_tokens: 900_000, tool_uses: 3_000, duration_ms: 600_000 }
  })
  return messages
}
