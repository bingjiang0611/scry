import { createRoot } from 'react-dom/client'
import { App } from '../../src/renderer/App'
import type { ActiveRun } from '../../src/shared/trace'
import type { AgentStartRequest } from '../../src/shared/runtime'
import type { ProviderContext } from '../../src/shared/provider'
import type { ProjectMeta } from '../../src/preload'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

// Production App, isolated bridge: no real Provider, workspace, or user data.
localStorage.clear()
const requests: AgentStartRequest[] = []
const capabilityRequests: { skills: ProviderContext[]; mcp: ProviderContext[] } = { skills: [], mcp: [] }
const runs = new Map<string, ActiveRun>()
const projects: ProjectMeta[] = [{ cwd: '/fixture', name: 'Models', mtime: 1, sessions: [] }]
const listeners = new Map<string, Set<(event: never) => void>>()
function subscribe<T>(name: string, callback: (event: T) => void) {
  const set = listeners.get(name) ?? new Set()
  listeners.set(name, set)
  set.add(callback)
  return () => { set.delete(callback) }
}
function emit(name: string, event: unknown) {
  for (const callback of listeners.get(name) ?? []) callback(event as never)
}
let focusedRun: string | null = null
const status = document.createElement('output')
status.id = 'model-state'
status.hidden = true
const update = () => { status.textContent = JSON.stringify({ requests, capabilityRequests }) }
const agents = [
  { id: 'claude', name: 'Claude Code', path: '/fixture/claude', bin: 'claude' },
  { id: 'codex', name: 'Codex', path: '/fixture/codex', bin: 'codex' },
  { id: 'pi:first', name: 'Pi first', path: '/fixture/pi', bin: 'pi' },
  { id: 'pi:second', name: 'Pi second', path: '/fixture/pi', bin: 'pi' }
]
Object.defineProperty(window, 'scry', { value: {
  activeRun: async () => focusedRun ? runs.get(focusedRun) : null,
  activeRuns: async () => [...runs.values()],
  onTrace: (cb: (event: unknown) => void) => subscribe('trace', cb),
  onSession: (cb: (event: unknown) => void) => subscribe('session', cb),
  onTurnDone: (cb: (event: unknown) => void) => subscribe('done', cb),
  onError: () => () => {},
  listProjects: async () => projects, recentFolders: async () => ['/fixture'],
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => agents, detectFast: async () => agents,
  listSkills: async (context: ProviderContext) => {
    capabilityRequests.skills.push(context)
    update()
    return { ...context, mode: 'read', state: 'unavailable', data: null, reason: 'fixture Skill unavailable' }
  },
  mcpSnapshot: async (context: ProviderContext) => {
    capabilityRequests.mcp.push(context)
    update()
    return { ...context, mode: 'read', state: 'unavailable', data: null, reason: 'fixture MCP unavailable' }
  },
  usageStats: async () => null, stats: async () => null,
  setCwd: async (cwd: string) => cwd,
  focusRun: async (runId: string | null) => { focusedRun = runId; return true },
  adoptActiveRun: async (runId: string) => { focusedRun = runId; return runs.get(runId) },
  newSession: async () => true,
  loadSession: async (context: ProviderContext) => ({
    turns: [...runs.values()].filter((run) => (run.externalSessionId ?? run.runId) === context.externalSessionId),
    offset: 0, totalTurns: 1, hasOlder: false, completeness: 'complete'
  }),
  runControls: async (context: ProviderContext) => ({ ...context, mode: 'read', state: 'ready', data: {
    models: ['model-1', 'model-2'].map((id) => ({
      model: { id }, label: id, efforts: [{ id: 'high', label: 'High' }]
    })),
    permissions: [{ id: 'default', label: '默认审批', description: 'fixture' }]
  } }),
  start: async (request: AgentStartRequest) => {
    requests.push(request)
    const runId = `run-${requests.length}`
    const run: ActiveRun = { runId, providerId: 'claude', cwd: '/fixture',
      externalSessionId: request.expectedExternalSessionId ?? undefined, userText: request.prompt, items: [], done: false }
    runs.set(runId, run)
    focusedRun = runId
    if (request.expectedExternalSessionId == null) projects[0].sessions.push({
      sessionId: runId, runId, providerId: 'claude', mtime: requests.length,
      preview: request.prompt, count: 1
    })
    update()
    return { runId }
  }
} })
const controls = document.createElement('div')
controls.style.cssText = 'position:fixed;right:0;top:0;z-index:99999;background:white;color:black'
for (const [id, action] of Object.entries({
  'capture-first': () => {
    const run = runs.get('run-1')!
    run.externalSessionId = 'native-1'
    projects[0].sessions[0].sessionId = 'native-1'
    projects[0].sessions[0].externalSessionId = 'native-1'
    emit('session', { runId: 'run-1', sessionId: 'native-1', providerId: 'claude' })
  },
  'finish-first': () => {
    runs.get('run-1')!.done = true
    emit('done', { runId: 'run-1', sessionId: 'native-1', providerId: 'claude' })
  },
  'finish-second': () => {
    runs.get('run-2')!.done = true
    runs.get('run-2')!.externalSessionId = 'native-2'
    projects[0].sessions[1].sessionId = 'native-2'
    projects[0].sessions[1].externalSessionId = 'native-2'
    // Native id first arrives at terminal, while another conversation is selected.
    emit('done', { runId: 'run-2', sessionId: 'native-2', providerId: 'claude' })
  },
  'legacy': () => {
    runs.set('legacy-run', { runId: 'legacy-run', providerId: 'claude', cwd: '/fixture',
      externalSessionId: 'legacy-session', userText: 'Legacy conversation', done: true, items: [{
        id: 'legacy-controls', runId: 'legacy-run', ts: '', kind: 'harness', stage: 'runtime:controls',
        input: { model: { id: 'model-1' }, effort: 'high', permissionMode: 'default' }
      }] })
    projects[0].sessions.push({ sessionId: 'legacy-alias', externalSessionId: 'legacy-session',
      providerId: 'claude', mtime: 1, preview: 'Legacy conversation', count: 1 })
    emit('done', { runId: 'legacy-run', sessionId: 'legacy-session', providerId: 'claude' })
  },
  'remount': () => { root.unmount(); root = createRoot(document.getElementById('root')!); root.render(<App />) }
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
let root = createRoot(document.getElementById('root')!)
root.render(<App />)
