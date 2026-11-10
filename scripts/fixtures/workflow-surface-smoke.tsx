import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { WORKFLOW_FIXTURE_SNAPSHOTS, workflowFixtureMessages } from '../../src/shared/claude-workflow.fixture'
import type { TraceEvent } from '../../src/shared/trace'
import { type NormalizeCtx, normalizeSdkMessage } from '../../src/main/normalize'
import { WorkflowSurface } from '../../src/renderer/components/WorkflowSurface'
import { requestWorkflowRun } from '../../src/renderer/workflow-focus'
import type { Turn } from '../../src/renderer/format'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/codex-alignment.css'

// Synthetic wire messages go through the production normalizer, so the surface is fed the
// same event shapes main emits. No Provider, account or real workflow run is involved.
const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'complete'

function events(messages: Array<Record<string, unknown>>): TraceEvent[] {
  let n = 0
  const base = Date.parse('2026-11-10T21:13:00Z')
  const ctx: NormalizeCtx = { runId: 'run-1', newId: () => `ev-${n++}`, now: () => new Date(base + n * 1_000).toISOString() }
  return messages.flatMap((message) => normalizeSdkMessage(message, ctx))
}

function turns(): { turns: Turn[]; busy: boolean } {
  const turn = (items: TraceEvent[], done: boolean): Turn => ({ runId: 'run-1', userText: 'ultracode: audit routes', items, done })
  if (mode === 'empty') return { turns: [turn([], true)], busy: false }
  if (mode === 'running') return { turns: [turn(events(workflowFixtureMessages({ progressSteps: 4 })), false)], busy: true }
  if (mode === 'unknown') return { turns: [turn(events(workflowFixtureMessages({ progressSteps: 4 })), true)], busy: false }
  if (mode === 'unavailable') {
    return { turns: [turn(events([
      ...workflowFixtureMessages({ progressSteps: 0 }).map((message) =>
        message.type === 'assistant'
          ? { ...message, message: { content: [{ type: 'tool_use', id: 'toolu_workflow_1', name: 'Workflow', input: { name: 'deep-research' } }] } }
          : message.subtype === 'task_started' ? { ...message, prompt: '' } : message),
      { type: 'system', subtype: 'task_progress', task_id: 'wtask-1', usage: { total_tokens: 4_200, tool_uses: 6, duration_ms: 9_000 } }
    ]), false)], busy: true }
  }
  return { turns: [turn(events(workflowFixtureMessages()), true)], busy: false }
}

// Two runs in one session, entered from a chat card that asks for the first one. The user then
// picks the second by hand, and the next stream update must not drag the selection back.
const FIRST_TOOL_USE = 'toolu_workflow_a'
const SECOND_RUN = 'task:wtask-b'

function FocusFixture() {
  const [items, setItems] = useState<TraceEvent[]>(() => [
    ...events(workflowFixtureMessages({ taskId: 'wtask-a', toolUseId: FIRST_TOOL_USE })),
    ...events(workflowFixtureMessages({ taskId: 'wtask-b', toolUseId: 'toolu_workflow_b' }))
  ])
  useEffect(() => { requestWorkflowRun(FIRST_TOOL_USE) }, [])
  useEffect(() => {
    // Stand-in for the next streaming snapshot of the first run.
    (window as unknown as { streamNext?: () => void }).streamNext = () => setItems((previous) => [...previous,
      ...events([{
        type: 'system', subtype: 'task_progress', task_id: 'wtask-a', tool_use_id: FIRST_TOOL_USE,
        usage: { total_tokens: 91_000, tool_uses: 40, duration_ms: 61_000 },
        workflow_progress: WORKFLOW_FIXTURE_SNAPSHOTS[0]
      }])])
  }, [])
  return <WorkflowSurface busy turns={[{ runId: 'run-1', userText: 'two runs', items, done: false }]} />
}

if (mode === 'focus') {
  createRoot(document.getElementById('root')!).render(<div style={{ height: '100vh', display: 'grid' }}><FocusFixture /></div>)
} else {
const state = turns()
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'grid' }}><WorkflowSurface turns={state.turns} busy={state.busy} /></div>
)
}
