import { createRoot } from 'react-dom/client'
import { workflowFixtureMessages } from '../../src/shared/claude-workflow.fixture'
import type { TraceEvent } from '../../src/shared/trace'
import { type NormalizeCtx, normalizeSdkMessage } from '../../src/main/normalize'
import { WorkflowSurface } from '../../src/renderer/components/WorkflowSurface'
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

const state = turns()
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'grid' }}><WorkflowSurface turns={state.turns} busy={state.busy} /></div>
)
