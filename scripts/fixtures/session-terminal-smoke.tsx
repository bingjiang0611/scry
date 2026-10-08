import { createRoot } from 'react-dom/client'
import { App } from '../../src/renderer/App'
import type { ProviderContext } from '../../src/shared/provider'
import type { TerminalDataEvent, TerminalExitEvent, TerminalRecordingRequest, TerminalSessionInfo, TerminalStartRequest } from '../../src/shared/terminal'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

// Production App/xterm with an isolated bridge. No real Shell, Provider, or user data.
localStorage.clear()
const scenario = new URLSearchParams(location.search).get('scenario')
const sessions = new Map<string, TerminalSessionInfo>()
if (scenario === 'restored') sessions.set('terminal-original', {
  id: 'terminal-original', pid: 1, cwd: '/fixture/old', cols: 80, rows: 24, ownershipEpoch: 1
})
const starts: TerminalStartRequest[] = []
const attaches: string[] = []
const closes: string[] = []
const writes: string[] = []
const dataListeners = new Set<(event: TerminalDataEvent) => void>()
const exitListeners = new Set<(event: TerminalExitEvent) => void>()
let releaseStart: (() => void) | null = null
let cwd: string | null = null
const status = document.createElement('output')
status.id = 'terminal-state'
status.hidden = true
const update = () => { status.textContent = JSON.stringify({ cwd, starts, attaches, closes, writes, pending: releaseStart != null }) }
const projects = [
  { cwd: '/fixture/old', name: 'Old project', mtime: 1, sessions: [
    { sessionId: 'one', externalSessionId: 'one', providerId: 'claude', mtime: 1, preview: 'First conversation', count: 1 },
    { sessionId: 'two', externalSessionId: 'two', providerId: 'claude', mtime: 2, preview: 'Same project conversation', count: 1 }
  ] },
  { cwd: '/fixture/new', name: 'New project', mtime: 2, sessions: [
    { sessionId: 'three', externalSessionId: 'three', providerId: 'claude', mtime: 3, preview: 'Other project conversation', count: 1 }
  ] }
]
const noopSubscribe = () => () => {}
Object.defineProperty(window, 'scry', { value: {
  activeRun: async () => null, activeRuns: async () => [],
  onTrace: noopSubscribe, onTurnDone: noopSubscribe, onError: noopSubscribe,
  listProjects: async () => projects, recentFolders: async () => projects.map((project) => project.cwd),
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }), detect: async () => [],
  listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  usageStats: async () => null, stats: async () => null,
  setCwd: async (next: string | null) => { cwd = next; update(); return cwd },
  focusRun: async () => true, newSession: async () => true,
  loadSession: async (context: ProviderContext) => ({ turns: [{
    runId: context.externalSessionId, userText: `History for ${context.externalSessionId}`, items: [], done: true
  }], offset: 0, totalTurns: 1, hasOlder: false, completeness: 'complete' }),
  terminalActive: async () => [...sessions.values()],
  terminalStart: async (request: TerminalStartRequest) => {
    starts.push(request)
    const session = { id: `terminal-new-${starts.length}`, pid: starts.length + 1,
      cwd: request.cwd ?? '/fixture/home', cols: request.cols, rows: request.rows, ownershipEpoch: 1 }
    if (scenario === 'pending' && starts.length === 1) {
      await new Promise<void>((resolve) => { releaseStart = resolve; update() })
      releaseStart = null
    }
    sessions.set(session.id, session)
    update()
    return session
  },
  terminalAttach: async (id: string) => {
    attaches.push(id)
    update()
    return { ...sessions.get(id)!, catchUp: { endOffset: 0, state: 'available' } }
  },
  terminalReady: async (id: string, ownershipEpoch: number) => {
    dataListeners.forEach((listener) => listener({ id, ownershipEpoch, data: 'original-screen-marker\r\n' }))
    return true
  },
  terminalWrite: async (id: string, ownershipEpoch: number, data: string) => {
    writes.push(data)
    dataListeners.forEach((listener) => listener({ id, ownershipEpoch, data }))
    update()
    return true
  },
  terminalResize: async () => true, terminalAck: async () => true,
  terminalRecordingList: async () => ({ items: [{ id: 'terminal-recorded', bytes: 34, state: 'complete', active: false }], nextCursor: null, partial: false }),
  terminalRecordingRead: async (request: TerminalRecordingRequest) => ({
    id: request.id, encoding: 'utf16le', data: 'recorded-marker\r\n', offset: 0,
    nextOffset: 34, totalBytes: 34, hasMore: false, state: 'complete'
  }),
  terminalClose: async (id: string) => { closes.push(id); sessions.delete(id); update(); return true },
  onTerminalData: (listener: (event: TerminalDataEvent) => void) => { dataListeners.add(listener); return () => dataListeners.delete(listener) },
  onTerminalExit: (listener: (event: TerminalExitEvent) => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener) },
  onTerminalRecordingError: noopSubscribe
} })
const controls = document.createElement('div')
controls.style.cssText = 'position:fixed;left:250px;bottom:0;z-index:99999;background:white;color:black'
for (const [id, action] of Object.entries({
  'resolve-terminal': () => releaseStart?.(),
  'terminal-exit': () => {
    const session = [...sessions.values()][0]
    sessions.delete(session.id)
    exitListeners.forEach((listener) => listener({ id: session.id, ownershipEpoch: session.ownershipEpoch, code: 0, signal: null }))
  }
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
