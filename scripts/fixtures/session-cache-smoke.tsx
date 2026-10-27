import { createRoot } from 'react-dom/client'
import { unavailableWorkspaceSelection } from './workspace-selection-unavailable'
import { App } from '../../src/renderer/App'
import type { ProjectMeta, SessionHistoryPage, TraceBacklogState, TraceBatchReceipt } from '../../src/preload'
import type { ActiveRun, TraceEvent } from '../../src/shared/trace'
import type { ProviderContext } from '../../src/shared/provider'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/analytics-evidence.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/codex-alignment.css'

// Full production renderer with explicit asynchronous bridge boundaries. No
// provider, real filesystem, permissions, or personal session data is accessed.
localStorage.clear()
const versions = new Map([['cache-a', 1], ['cache-b', 1]])
const projects: ProjectMeta[] = [{ cwd: '/fixture/cache', name: 'Cache fixture', mtime: 1,
  sessions: ['cache-a', 'cache-b'].map(sessionId => ({ sessionId, externalSessionId: sessionId,
    providerId: 'claude', mtime: 1, preview: sessionId, count: 1 })) }]
const pending: Array<{ sessionId: string; resolve: (page: SessionHistoryPage) => void; reject: (error: Error) => void }> = []
const dataListeners = new Set<(event: { runId: string; kind: 'session_deleted' }) => void>()
let reads = 0
let starts = 0
let forks = 0
let traceAcknowledgements = 0
let traceRecoveries = 0
let recoveryReads = 0
let bufferNextSelection = false
const traceListeners = new Set<(events: TraceEvent[], receipt?: TraceBatchReceipt) => void>()
const healthListeners = new Set<(health: TraceBacklogState) => void>()
const focusListeners = new Set<(run: ActiveRun) => void>()
const status = document.createElement('output')
status.id = 'cache-state'
const update = () => { status.textContent = JSON.stringify({ reads, starts, forks, traceAcknowledgements, traceRecoveries, recoveryReads, pending: pending.map(item => item.sessionId) }) }
const noopSubscribe = () => () => {}
const agent = { id: 'claude', name: 'Claude Code', path: '/fixture/claude', bin: 'claude', health: { state: 'ready' } }
export function page(sessionId: string): SessionHistoryPage {
  const runId = `${sessionId}-turn`
  return { turns: [{ runId, providerTurnId: `${sessionId}-native-turn`, userText: `Prompt ${sessionId}`,
    done: true, items: [{ id: `${runId}-text`, runId, ts: '2026-10-14T00:00:00Z', kind: 'model', stage: 'text',
      text: `Authoritative ${sessionId} v${versions.get(sessionId)}`, model: 'fixture-model' }] }],
    offset: 0, totalTurns: 1, hasOlder: false, completeness: 'complete' }
}
Object.defineProperty(window, 'scry', { value: {
  workspaceSelection: unavailableWorkspaceSelection,
  activeRun: async () => null, activeRuns: async () => [],
  focusedRunSnapshot: async () => { recoveryReads++; update(); return null },
  onTrace: (callback: (events: TraceEvent[], receipt?: TraceBatchReceipt) => void) => {
    traceListeners.add(callback); return () => traceListeners.delete(callback)
  },
  traceAck: async () => { traceAcknowledgements++; update(); return true },
  onTraceHealth: (callback: (health: TraceBacklogState) => void) => {
    healthListeners.add(callback); return () => healthListeners.delete(callback)
  },
  traceResynchronized: async () => { traceRecoveries++; update(); return true },
  onSession: noopSubscribe, onTurnDone: noopSubscribe, onError: noopSubscribe,
  onFocusedRun: (callback: (run: ActiveRun) => void) => {
    focusListeners.add(callback); return () => focusListeners.delete(callback)
  },
  onDataUpdated: (callback: (event: { runId: string; kind: 'session_deleted' }) => void) => {
    dataListeners.add(callback); return () => dataListeners.delete(callback)
  },
  listProjects: async () => structuredClone(projects), recentFolders: async () => ['/fixture/cache'],
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detectFast: async () => [agent], detect: async () => [agent],
  listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  usageStats: async () => null, usageAnalytics: async () => null, stats: async () => null,
  setCwd: async (cwd: string) => cwd, focusRun: async () => true, newSession: async () => true,
  runControls: async (context: ProviderContext) => ({ ...context, mode: 'read', state: 'ready', data: {
    models: [{ model: { id: 'fixture-model' }, label: 'Fixture model', efforts: [] }],
    permissions: [{ id: 'default', label: '默认审批', description: 'fixture' }]
  } }),
  loadSession: (context: ProviderContext) => {
    reads++; update()
    return new Promise<SessionHistoryPage>((resolve, reject) => {
      pending.push({ sessionId: context.externalSessionId!, resolve, reject }); update()
    })
  },
  start: async () => { starts++; update(); throw new Error('Cache fixture must not launch a Provider') },
  forkSession: async () => { forks++; update(); throw new Error('Cache fixture must not fork before refresh') }
} })
createRoot(document.getElementById('root')!).render(<App />)
// Capture phase runs before App's native sidebar click handler. This leaves a
// real trace batch queued for the same selection, without a programmatic click.
document.addEventListener('click', event => {
  if (!bufferNextSelection || !(event.target instanceof Element) || !event.target.closest('button.sb-sess')) return
  bufferNextSelection = false
  traceListeners.forEach(listener => listener([{ id: 'buffered-old', runId: 'previous-buffered-focus', ts: '',
    kind: 'model', stage: 'text', text: 'BUFFERED BEFORE SELECTION' }], { generation: 1, batchId: 2, bytes: 100 }))
}, true)
const controls = document.createElement('div')
controls.style.cssText = 'position:fixed;right:0;top:0;z-index:99999;background:white;color:black;max-width:440px'
for (const [id, action] of Object.entries({
  'resolve-a': () => resolve('cache-a'), 'resolve-b': () => resolve('cache-b'),
  'update-a': () => versions.set('cache-a', 2),
  'arm-buffer-on-selection': () => { bufferNextSelection = true },
  'focus-live-b': () => {
    const run: ActiveRun = { runId: 'live-b', providerId: 'claude', cwd: '/fixture/cache', externalSessionId: 'cache-b',
      userText: 'Live B prompt', done: false, items: [{ id: 'live-b-text', runId: 'live-b', ts: '',
        kind: 'model', stage: 'text', text: 'AUTHORITATIVE LIVE B' }] }
    focusListeners.forEach(listener => listener(run)); update()
  },
  'emit-old-trace': () => {
    traceListeners.forEach(listener => listener(['cache-b-turn', 'previous-main-focus'].map(runId => ({
      id: `${runId}-late`, runId, ts: '', kind: 'model', stage: 'text', text: 'STALE OTHER SESSION'
    })), { generation: 1, batchId: 1, bytes: 100 })); update()
  },
  'emit-degraded-health': () => {
    healthListeners.forEach(listener => listener({ degraded: true, skippedEvents: 12, bufferedEvents: 0,
      bufferedBytes: 0, inFlightBytes: 0, resyncRequired: true })); update()
  },
  'reject-a': () => { const index = pending.findIndex(item => item.sessionId === 'cache-a'); pending.splice(index, 1)[0].reject(new Error('fixture source unavailable')); update() },
  'reject-b': () => { const index = pending.findIndex(item => item.sessionId === 'cache-b'); pending.splice(index, 1)[0].reject(new Error('fixture target unavailable')); update() },
  'invalidate-cache': invalidateCache
})) {
  const button = document.createElement('button')
  button.id = id; button.textContent = id; button.onclick = action
  controls.append(button)
}
export function invalidateCache(): void {
  dataListeners.forEach(listener => listener({ runId: 'deleted-turn', kind: 'session_deleted' })); update()
}
function resolve(sessionId: string): void {
  const index = pending.findIndex(item => item.sessionId === sessionId)
  pending.splice(index, 1)[0].resolve(page(sessionId)); update()
}
controls.append(status)
document.body.append(controls)
update()
