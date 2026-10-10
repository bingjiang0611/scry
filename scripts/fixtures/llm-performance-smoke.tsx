import { createRoot } from 'react-dom/client'
import { App } from '../../src/renderer/App'
import { LlmPerformanceObserver } from '../../src/main/llm-performance'
import type { AgentStartRequest } from '../../src/shared/runtime'
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
const requests: AgentStartRequest[] = []
let time = 0
let epoch = 0
let observer: LlmPerformanceObserver
const events: TraceEvent[] = []
let failHistory = false
const status = document.createElement('output')
status.id = 'performance-fixture-state'
status.hidden = true
const update = () => { status.textContent = JSON.stringify({ requests, rows: rows.length }) }
const publish = (partial: Partial<TraceEvent>, at: number) => {
  time = at
  const event: TraceEvent = { id: `event-${events.length}`, runId: 'fixture-run', ts: new Date(epoch + at).toISOString(), kind: 'model', stage: 'text_delta', ...partial }
  event.llmPerformance = observer.observe(event, events)
  events.push(event)
  traceListeners.forEach(listener => listener([event]))
  return event
}
const subscribe = <T,>(listeners: Set<T>) => (callback: T) => { listeners.add(callback); return () => { listeners.delete(callback) } }
const noopSubscribe = () => () => {}
const agents = [{ id: 'claude', name: 'Claude Code', path: '/fixture/claude', bin: 'claude', health: { state: 'ready', transport: 'sdk' } }]
Object.defineProperty(window, 'scry', { value: {
  activeRun: async () => null, activeRuns: async () => [],
  onTrace: subscribe(traceListeners), onTurnDone: subscribe(doneListeners), onError: noopSubscribe,
  listProjects: async () => [], recentFolders: async () => [],
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => agents, detectFast: async () => agents,
  listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  usageStats: async () => null, stats: async () => null,
  runControls: async () => ({ mode: 'read', state: 'ready', data: { models: [], permissions: [{ id: 'default', label: '默认审批', description: 'fixture' }] } }),
  llmPerformanceHistory: async () => {
    if (failHistory) throw new Error('fixture history unavailable')
    return { rows: [...rows], invalidLines: 0, truncated: false }
  },
  start: async (request: AgentStartRequest) => {
    requests.push(request)
    epoch = Date.now() - 2000
    time = 0
    observer = new LlmPerformanceObserver(request.networkLabel, { monotonic: () => time, now: () => epoch + time })
    update()
    return { runId: 'fixture-run' }
  }
} })
const controls = document.createElement('div')
controls.style.cssText = 'position:fixed;right:0;top:0;z-index:99999;background:white;color:black'
for (const [id, action] of Object.entries({
  'performance-stream': () => { publish({ text: 'abc' }, 1000); publish({ text: 'def' }, 2000) },
  'performance-complete': () => {
    publish({ kind: 'harness', stage: 'result', tokensOut: 100, durationApiMs: 5000 }, 3000)
    const end = publish({ kind: 'harness', stage: 'runtime:turn_wall', durationMs: 3000 }, 3000)
    rows.push({ runId: 'fixture-run', ts: end.ts, providerId: 'claude', model: 'fixture-model', networkLabel: requests[0].networkLabel ?? '', failed: false, performance: end.llmPerformance! })
    doneListeners.forEach(listener => listener({ runId: 'fixture-run' }))
    update()
  },
  'performance-history-error': () => { failHistory = true }
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
