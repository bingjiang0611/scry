import { createRoot } from 'react-dom/client'
import { App } from '../../src/renderer/App'
import type { AgentStartRequest, AgentRunControlCatalog } from '../../src/shared/runtime'
import type { CapabilityEnvelope, ProviderContext } from '../../src/shared/provider'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/codex-alignment.css'

// Production App, isolated bridge. The catalog stays pending until native input releases it.
// No Provider is launched and no real workspace or user data is touched.
localStorage.clear()
const saved = new URLSearchParams(location.search).get('scenario') === 'saved'
localStorage.setItem('scry:run-control-preferences:v1', JSON.stringify({
  selectedAgentId: 'pi:rotom',
  controlsByProvider: saved ? { pi: { permissionMode: 'full_access' } } : {}
}))
const requests: AgentStartRequest[] = []
const pending: Array<() => void> = []
const status = document.createElement('output')
status.id = 'permission-state'
let enterReceipts = 0
const update = () => { status.textContent = JSON.stringify({ requests, pending: pending.length, enterReceipts }) }
document.addEventListener('keyup', (event) => {
  if (event.key === 'Enter') { enterReceipts += 1; update() }
})
const agents = [{ id: 'pi:rotom', name: 'Pi · Rotom', path: '/fixture/pi', bin: 'pi', health: { state: 'ready', transport: 'rpc' } }]
const noopSubscribe = () => () => {}
Object.defineProperty(window, 'scry', { value: {
  activeRun: async () => null, activeRuns: async () => [],
  onTrace: noopSubscribe, onTurnDone: noopSubscribe, onError: noopSubscribe,
  listProjects: async () => [], recentFolders: async () => [],
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => agents, detectFast: async () => agents,
  listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  usageStats: async () => null, stats: async () => null,
  runControls: (context: ProviderContext) => new Promise<CapabilityEnvelope<AgentRunControlCatalog>>((resolve) => {
    pending.push(() => resolve({ ...context, mode: 'read', state: 'ready', data: {
      models: [], permissions: [{ id: 'full_access', label: '本机完全访问', description: '以本机用户权限运行；Pi 没有内置审批模式' }]
    } }))
    update()
  }),
  start: async (request: AgentStartRequest) => {
    requests.push(request)
    update()
    return { runId: 'fixture-pi-run' }
  }
} })
const controls = document.createElement('div')
controls.style.cssText = 'position:fixed;right:0;top:0;z-index:99999;background:white;color:black'
const release = document.createElement('button')
release.id = 'resolve-permissions'
release.textContent = 'Resolve permissions'
release.onclick = () => { pending.splice(0).forEach((resolve) => resolve()); update() }
controls.append(release, status)
document.body.append(controls)
update()
createRoot(document.getElementById('root')!).render(<App />)
