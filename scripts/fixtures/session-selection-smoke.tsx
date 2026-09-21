import { createRoot } from 'react-dom/client'
import { App } from '../../src/renderer/App'
import type { ActiveRun } from '../../src/shared/trace'
import type { ProviderContext } from '../../src/shared/provider'
import type { ProjectMeta } from '../../src/preload'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

// Full production App with an isolated bridge: no Provider, filesystem or user data access.
const oldRun: ActiveRun = {
  runId: 'old-run', providerId: 'claude', cwd: '/fixture/old', externalSessionId: 'old-session',
  userText: 'Old running conversation', done: false, items: []
}
const projects: ProjectMeta[] = [
  { cwd: '/fixture/old', name: 'Old project', mtime: 1, sessions: [{
    sessionId: 'old-session', externalSessionId: 'old-session', runId: 'old-run',
    providerId: 'claude', mtime: 1, preview: 'Old running conversation', count: 1
  }] },
  { cwd: '/fixture/new', name: 'New project', mtime: 2, sessions: [{
    sessionId: 'new-session', externalSessionId: 'new-session', providerId: 'pi', agentProfileId: 'pi:rotom',
    mtime: 2, preview: 'Target Pi conversation', count: 1
  }] }
]
const listeners = new Set<(run: ActiveRun) => void>()
let cwd: string | null = '/fixture/old'
let activeReads = 0
let historyReads = 0
let cancelledLoads = 0
let pendingHistory: { cwd: string; resolve: () => void; reject: (error: Error) => void } | null = null
const pendingSnapshots: Array<() => void> = []
const noopSubscribe = () => () => {}
const status = document.createElement('output')
status.id = 'selection-state'
const update = () => {
  status.textContent = JSON.stringify({ cwd, activeReads, historyReads, cancelledLoads, snapshots: pendingSnapshots.length })
}
const bridge = {
  activeRun: () => {
    activeReads += 1
    update()
    return new Promise<ActiveRun>((resolve) => { pendingSnapshots.push(() => resolve(oldRun)); update() })
  },
  activeRuns: async () => [oldRun],
  onFocusedRun: (callback: (run: ActiveRun) => void) => { listeners.add(callback); return () => listeners.delete(callback) },
  onTrace: noopSubscribe, onTurnDone: noopSubscribe, onError: noopSubscribe,
  listProjects: async () => projects, recentFolders: async () => projects.map((project) => project.cwd),
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => [],
  listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  usageStats: async () => null, stats: async () => null,
  focusRun: async () => true,
  adoptActiveRun: async () => oldRun,
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
    historyReads += 1
    update()
    return new Promise((resolve, reject) => {
      pendingHistory = { cwd: context.cwd ?? '', reject, resolve: () => {
        cwd = context.cwd ?? null
        resolve({ turns: [{ runId: `${context.externalSessionId}-history`, userText: `History for ${context.externalSessionId}`, items: [], done: true }], offset: 0, totalTurns: 1, hasOlder: false, completeness: 'complete' })
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
