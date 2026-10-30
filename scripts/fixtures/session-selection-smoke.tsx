import { createRoot } from 'react-dom/client'
import { unavailableWorkspaceSelection } from './workspace-selection-unavailable'
import { App } from '../../src/renderer/App'
import type { ActiveRun } from '../../src/shared/trace'
import type { ProviderContext } from '../../src/shared/provider'
import type { ProjectMeta } from '../../src/preload'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/codex-alignment.css'

// Full production App with an isolated bridge: no Provider, filesystem or user data access.
const scenario = new URLSearchParams(location.search).get('scenario')
const sameProvider = scenario === 'same-provider'
const oldIdentity = sameProvider
  ? { providerId: 'pi' as const, agentProfileId: 'pi:rotom' }
  : { providerId: 'claude' as const }
const oldRun: ActiveRun = {
  runId: 'old-run', ...oldIdentity, cwd: '/fixture/old', externalSessionId: 'old-session',
  userText: 'Old running conversation', done: false, items: []
}
const projects: ProjectMeta[] = [
  { cwd: '/fixture/old', name: 'Old project', mtime: 1, sessions: [{
    sessionId: 'old-session', externalSessionId: 'old-session', runId: 'old-run',
    ...oldIdentity, mtime: 1, preview: 'Old running conversation', count: 1
  }] },
  { cwd: '/fixture/new', name: 'New project', mtime: 2, sessions: [{
    sessionId: 'new-session', externalSessionId: 'new-session', providerId: 'pi', agentProfileId: 'pi:rotom',
    runId: scenario === 'stale-run' ? 'previous-pi-run' : undefined,
    mtime: 2, preview: 'Target Pi conversation', count: 1
  }] }
]
const hiddenRun: ActiveRun = {
  runId: 'hidden-pi-run', providerId: 'pi', agentProfileId: 'pi:rotom',
  cwd: '/fixture/new', externalSessionId: 'new-session',
  userText: 'Live target Pi conversation', done: false,
  items: [{ id: 'live-answer', runId: 'hidden-pi-run', ts: '2026-10-09T00:00:00Z', kind: 'model', stage: 'text', text: 'Actual live response before archival' }]
}
const previousHiddenRun: ActiveRun = { ...hiddenRun, runId: 'previous-pi-run', userText: 'Previous target task', items: [] }
let hiddenRunAvailable = false
let activeListReads = 0
const adoptedRuns: string[] = []
const listeners = new Set<(run: ActiveRun) => void>()
let cwd: string | null = '/fixture/old'
let activeReads = 0
let historyReads = 0
const historyOperations: string[] = []
let cancelledLoads = 0
let newSessions = 0
let starts = 0
let pendingHistory: { cwd: string; resolve: () => void; reject: (error: Error) => void } | null = null
const pendingSnapshots: Array<() => void> = []
const noopSubscribe = () => () => {}
const status = document.createElement('output')
status.id = 'selection-state'
const update = () => {
  status.textContent = JSON.stringify({ cwd, activeReads, activeListReads, adoptedRuns, historyReads, historyOperations, cancelledLoads, newSessions, starts, snapshots: pendingSnapshots.length })
}
const bridge = {
  setLegacyDiffPreviewDemand: async () => true,
  workspaceSelection: unavailableWorkspaceSelection,
  activeRun: () => {
    activeReads += 1
    update()
    return new Promise<ActiveRun>((resolve) => { pendingSnapshots.push(() => resolve(oldRun)); update() })
  },
  activeRuns: async () => {
    activeListReads += 1
    update()
    return [oldRun, ...(hiddenRunAvailable ? [hiddenRun] : scenario === 'stale-run' ? [previousHiddenRun] : [])]
  },
  onFocusedRun: (callback: (run: ActiveRun) => void) => { listeners.add(callback); return () => listeners.delete(callback) },
  onTrace: noopSubscribe, onTurnDone: noopSubscribe, onError: noopSubscribe,
  // Match IPC snapshot identity; never share the mutable fixture catalog with React.
  listProjects: async () => structuredClone(projects), recentFolders: async () => projects.map((project) => project.cwd),
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => [],
  listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  usageStats: async () => null, stats: async () => null,
  focusRun: async () => true,
  newSession: async () => { newSessions += 1; update(); return true },
  start: async () => { starts += 1; update(); throw new Error('This selection fixture must not start a Provider') },
  adoptActiveRun: async (runId: string) => {
    adoptedRuns.push(runId)
    update()
    if (runId === previousHiddenRun.runId) return null
    return runId === hiddenRun.runId ? hiddenRun : oldRun
  },
  setCwd: async (next: string | null) => {
    if (next !== cwd && pendingHistory) {
      cancelledLoads += 1
      pendingHistory.reject(new Error('workspace changed'))
      pendingHistory = null
    }
    cwd = next
    update()
    return cwd
  },
  loadSession: (context: ProviderContext) => {
    if (pendingHistory) {
      cancelledLoads += 1
      pendingHistory.reject(new Error('history superseded'))
      pendingHistory = null
    }
    historyReads += 1
    historyOperations.push(`read:${context.externalSessionId}`)
    update()
    return new Promise((resolve, reject) => {
      pendingHistory = { cwd: context.cwd ?? '', reject, resolve: () => {
        historyOperations.push(`resolve:${context.externalSessionId}`)
        cwd = context.cwd ?? null
        resolve(scenario === 'stale-live' && context.externalSessionId === 'new-session' ? null : {
          turns: [{ runId: `${context.externalSessionId}-history`, userText: `History for ${context.externalSessionId}`, items: [], done: true }], offset: 0, totalTurns: 1, hasOlder: false, completeness: 'complete'
        })
        pendingHistory = null
        update()
      } }
    })
  }
}
Object.defineProperty(window, 'scry', { value: bridge })
localStorage.clear()
createRoot(document.getElementById('root')!).render(<App />)
// Deterministic async boundaries, driven by native input in the smoke runner.
const controls = document.createElement('div')
controls.style.cssText = 'position:fixed;right:0;top:0;z-index:99999;background:white;color:black'
for (const [id, action] of Object.entries({
  'resolve-snapshots': () => { pendingSnapshots.splice(0).forEach((resolve) => resolve()); update() },
  'resolve-history': () => pendingHistory?.resolve(),
  'start-hidden-pi': () => { hiddenRunAvailable = true; update() },
  'focus-pi': () => listeners.forEach((listener) => listener({ ...oldRun, runId: 'pi-run', providerId: 'pi', agentProfileId: 'pi:rotom', cwd: '/fixture/new', externalSessionId: 'new-session' }))
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
