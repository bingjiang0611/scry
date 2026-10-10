import { createRoot } from 'react-dom/client'
import { App } from '../../src/renderer/App'
import { LlmPerformanceObserver } from '../../src/main/llm-performance'
import { RunRegistry } from '../../src/main/run-registry'
import { LlmPerformanceSampling } from '../../src/main/llm-performance-sampling'
import type { ActiveRun } from '../../src/shared/trace'
import type { TraceEvent } from '../../src/shared/trace'
import type { LlmPerformanceHistoryRow } from '../../src/shared/llm-performance'
import '../../src/renderer/styles.css'
import '../../src/renderer/analytics-evidence.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/codex-alignment.css'

// Full production App + production observer, isolated bridge. No Provider or real user data.
localStorage.clear()
document.documentElement.dataset.platform = 'macos'
const traceListeners = new Set<(events: TraceEvent[]) => void>()
const doneListeners = new Set<(event: { runId: string }) => void>()
const rows: LlmPerformanceHistoryRow[] = []
const registry = new RunRegistry<ActiveRun, { runId: string }>()
const sampling = new LlmPerformanceSampling(() => registry.activeStates())
const dataListeners = new Set<(event: { runId: string; kind: 'turn_recorded' }) => void>()
const clocks = new Map<string, { time: number; observer: LlmPerformanceObserver }>()
const epoch = Date.now() - 10_000
for (const [runId, providerId, cwd] of [['first', 'claude', '/project-a'], ['second', 'pi', '/project-b'], ['waiting', 'codex', '/project-c']] as const) {
  const clock = { time: 0, observer: undefined as unknown as LlmPerformanceObserver }
  clock.observer = new LlmPerformanceObserver('', { monotonic: () => clock.time, now: () => epoch + clock.time })
  clocks.set(runId, clock)
  registry.register({ runId, providerId, cwd, externalSessionId: runId, done: false, items: [], userText: '' }, { runId })
}
sampling.registryChanged()
let failHistory = false
let failSummary = false
let summaryReads = 0
let historyReads = 0
const status = document.createElement('output')
status.id = 'performance-fixture-state'
status.hidden = true
const update = () => { status.textContent = JSON.stringify({ rows: rows.length, summaryReads, historyReads, dataListeners: dataListeners.size }) }
const publish = (runId: string, partial: Partial<TraceEvent>, at: number) => {
  const clock = clocks.get(runId)!
  clock.time = at
  const run = registry.get(runId)!.state
  const event: TraceEvent = { id: `${runId}-${run.items.length}`, runId, ts: new Date(epoch + at).toISOString(), kind: 'model', stage: 'text_delta', ...partial }
  event.llmPerformance = clock.observer.observe(event, run.items)
  run.llmPerformance = event.llmPerformance
  run.items.push(event)
  return event
}
const subscribe = <T,>(listeners: Set<T>) => (callback: T) => { listeners.add(callback); update(); return () => { listeners.delete(callback); update() } }
const noopSubscribe = () => () => {}
const agents = [{ id: 'claude', name: 'Claude Code', path: '/fixture/claude', bin: 'claude', health: { state: 'ready', transport: 'sdk' } }]
Object.defineProperty(window, 'scry', { value: {
  activeRun: async () => null, activeRuns: async () => [],
  onDataUpdated: subscribe(dataListeners),
  onTrace: subscribe(traceListeners), onTurnDone: subscribe(doneListeners), onError: noopSubscribe,
  listProjects: async () => [], recentFolders: async () => [],
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => agents, detectFast: async () => agents,
  listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  usageStats: async () => null, stats: async () => null,
  runControls: async () => ({ mode: 'read', state: 'ready', data: { models: [], permissions: [{ id: 'default', label: '默认审批', description: 'fixture' }] } }),
  llmPerformanceHistory: async () => {
    historyReads++; update()
    if (failHistory) throw new Error('fixture history unavailable')
    return { rows: [...rows], invalidLines: 0, truncated: false }
  },
  llmPerformanceSummary: async () => {
    summaryReads++; update()
    if (failSummary) throw new Error('fixture summary unavailable')
    return sampling.read()
  }

} })
const controls = document.createElement('div')
controls.style.cssText = 'position:fixed;right:0;top:0;z-index:99999;background:white;color:black'
for (const [id, action] of Object.entries({
  'performance-stream': () => {
    publish('first', { text: 'abc' }, 1000); publish('first', { text: 'def' }, 2000)
    publish('second', { text: 'other model' }, 3000)
  },
  'performance-focus': () => { registry.focus('waiting') },
  'performance-complete': () => {
    publish('first', { kind: 'harness', stage: 'result', tokensOut: 100, durationApiMs: 5000 }, 3000)
    const end = publish('first', { kind: 'harness', stage: 'runtime:turn_wall', durationMs: 3000 }, 3000)
    rows.push({ runId: 'first', ts: end.ts, providerId: 'claude', model: 'fixture-model', networkLabel: '', failed: false, performance: end.llmPerformance! })
    registry.get('first')!.state.done = true
    sampling.registryChanged()
    dataListeners.forEach(listener => listener({ runId: 'first', kind: 'turn_recorded' }))
    update()
  },
  'performance-stop': () => {
    const end = publish('second', { kind: 'harness', stage: 'runtime:turn_wall' }, 4000)
    rows.push({ runId: 'second', ts: end.ts, providerId: 'pi', model: 'other-model', networkLabel: 'old manual note', failed: true,
      performance: { ...end.llmPerformance!, networkLabel: 'old manual note' } })
    registry.get('second')!.state.done = true
    sampling.registryChanged()
    dataListeners.forEach(listener => listener({ runId: 'second', kind: 'turn_recorded' }))
  },
  'performance-empty': () => { registry.get('waiting')!.state.done = true; sampling.registryChanged() },
  'performance-history-error': () => { failHistory = true },
  'performance-summary-error': () => { failSummary = true }

})) {
  const button = document.createElement('button')
  button.id = id
  button.textContent = id
  button.onclick = action
  controls.append(button)
}
controls.append(status)
document.body.append(controls)
update()
createRoot(document.getElementById('root')!).render(<App />)
