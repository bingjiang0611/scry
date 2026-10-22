import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { nativeUiPointer } from './native-ui-pointer.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-desktop-remote-ui-'))
const negativeControl = process.argv.includes('--negative-control')
const negativeMachineControl = process.argv.includes('--negative-machine-control')
const negativeAddressControl = process.argv.includes('--negative-address-control')
const negativeHoverControl = process.argv.includes('--negative-hover-control')
const negativeActivityControl = process.argv.includes('--negative-activity-control')
const negativeWorkspaceControl = process.argv.includes('--negative-workspace-control')
const negativePromptControl = process.argv.includes('--negative-prompt-control')
const negativeSettingsControl = process.argv.includes('--negative-settings-control')
const negativeSlashControl = process.argv.includes('--negative-slash-control')
const negativeHistorySlashControl = process.argv.includes('--negative-history-slash-control')
const negativeProviderRevisionControl = process.argv.includes('--negative-provider-revision-control')
const settingsOnly = process.argv.includes('--remote-settings-only')
const parityOnly = process.argv.includes('--session-parity-only')
const composerHistoryOnly = process.argv.includes('--composer-history-only')
const lifecycleOnly = process.argv.includes('--session-lifecycle-only')
const openingOnly = process.argv.includes('--session-opening-only')
const measureOpening = process.argv.includes('--measure-session-opening')
const keepArtifacts = process.argv.includes('--keep')
let cleanupUnknown = false
let failed = false

// This is a renderer-only contract fixture. The bridge records calls but never starts a
// Provider, opens a socket, reads credentials, or calls the local run-control API.
const fixtureSource = `
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { RemoteHostPanel } from ${JSON.stringify(join(root, 'src/renderer/components/DesktopRemote.tsx'))}
import { App } from ${JSON.stringify(join(root, 'src/renderer/App.tsx'))}
import { refreshRemoteCatalog } from ${JSON.stringify(join(root, 'src/renderer/hooks/useRemoteCatalogs.ts'))}
import { refreshDesktopConnections } from ${JSON.stringify(join(root, 'src/renderer/hooks/useDesktopConnections.ts'))}
import ${JSON.stringify(join(root, 'src/renderer/styles.css'))}
import ${JSON.stringify(join(root, 'src/renderer/motion.css'))}
import ${JSON.stringify(join(root, 'src/renderer/codex-alignment.css'))}

const firstLedger = '11111111-1111-4111-8111-111111111111'
const secondLedger = '22222222-2222-4222-8222-222222222222'
const firstScryRun = 'remote-run-fixture-1'
const secondScryRun = 'remote-run-fixture-2'
const state = {
  historyPrompts: ['older remote prompt', 'latest remote prompt'],
  historyCalls: [], traceCalls: [], submitInputs: [], stopCalls: [], answerCalls: [], commandCalls: [], sessionActions: [],
  catalogCalls: 0, holdHistory: false, providerControlsCalls: [], holdProviderControls: false, providerControlWaiters: [],
  providerControlsFailure: null, legacyProviderHost: false,
  fileLists: [], fileReads: [], localWorkspaceCalls: [],
  uiEvents: [], backgroundStopCalls: 0, intentsCalls: 0, firstIntentCleared: false, answerFailure: false,
  intent: null, holdSubmit: false, runState: 'dispatched', exposeTrace: true, runStatusFailure: false, autoResetOnSubmit: false, holdRunStatus: false,
  connected: true, hostEnabled: false, hostInviteCalls: 0, hostDisableCalls: 0,
  localNewSessions: 0, localStarts: 0, listFailure: false, hideProvider: false, catalogRevision: 0,
  catalogFailure: false, sessionActive: false, sessionTs: 1700000000000, hostRunArchived: false, liveRunCalls: 0,
  updateSshCalls: [], connectCalls: 0, updateFailure: false, holdAddressUpdate: false,
  directoryReads: [], directorySelectCalls: [], directoryGrants: [], oldDirectoryHost: false, selectDirectoryFailure: false, holdDirectorySelection: false,
  phoneEnabled: true, relayConfigured: true, phoneStatusFailure: false, phonePairingCalls: 0,
  clipboardImageCalls: 0, forks: [], deletions: [], deleteFailure: false,
  commandFailure: false, holdCommands: false,
  providerMetadataObservedAt: 1700000000000, providerControlsObservedAt: 1700000000000, providerMetadataRevision: 1
}
const connection = {
  id: 'fixture-connection', label: 'Fixture desktop', hostId: 'fixture-host', anchorSHA256: 'fixture-fingerprint',
  ssh: { hostname: 'fixture.invalid', username: 'fixture', port: 22 }, state: 'connected', expiresAt: 4102444800000
}
const alpha = {
  id: 'claude', label: 'Alpha', available: true, modelId: 'alpha-default', forkSession: true,
  models: [{ id: 'alpha-default', providerId: 'claude', label: 'Alpha Default', isDefault: true,
    efforts: [{ id: 'alpha-effort', label: 'Alpha effort', isDefault: true }] }],
  permissions: [{ id: 'default', label: 'Default', isDefault: true }, { id: 'full_access', label: 'Full access' }]
}
const beta = {
  id: 'qoder', label: 'Beta', available: true,
  models: [{ id: 'beta-default', providerId: 'qoder', label: 'Beta Default', isDefault: true,
    efforts: [{ id: 'beta-effort', label: 'Beta effort', isDefault: true }] }],
  permissions: [{ id: 'default', label: 'Default', isDefault: true }]
}
const catalog = {
  projects: [{ path: '/fixture/project-a', label: 'Project A' }, { path: '/fixture/project-b', label: 'Project B' }],
  providers: [alpha, { ...alpha, agentProfileId: 'alternate', label: 'Profile Alternate', modelId: 'alpha-alternate',
    models: [{ id: 'alpha-alternate', label: 'Alternate model', isDefault: true }],
    permissions: [{ id: 'default', label: 'Default', isDefault: true }] }, beta],
  sessions: [
    { sessionId: 'old-session', externalSessionId: 'old-native', providerId: 'claude', cwd: '/fixture/project-a', label: 'Old session', ts: 1700000000000 },
    { sessionId: 'other-session', externalSessionId: 'other-native', providerId: 'qoder', cwd: '/fixture/project-b', label: 'Other history', ts: 1 }
  ],
  providerEvidence: 'host_snapshot', directorySelection: true, sessionActions: true, sessionFork: true, sessionDelete: true,
  attachments: { transport: 'chunked', maxBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxCount: 16, chunkBytes: 256 * 1024 }
}
const contextFor = (input) => ({ ...input.context })
const activeRun = (runId, externalSessionId, text, question, background = false) => ({
  runId, providerId: runId === firstScryRun ? 'claude' : 'qoder', cwd: '/fixture/project-a', externalSessionId,
  userText: text, done: false, pendingQuestions: question ? [question] : [], items: [
    { id: runId + '-text', runId, ts: '2026-10-08T12:00:00.000Z', kind: 'model', stage: 'text', text },
    ...(background ? [{ id: runId + '-work', runId, ts: '2026-10-08T12:00:01.000Z', kind: 'harness', stage: 'runtime:background_work', backgroundWork: {
      providerId: 'qoder', phase: 'waiting', quiet: false, coverage: 'partial', taskStop: 'available', lastEventAt: 1,
      tasks: [{ taskId: 'remote-task', toolUseId: 'remote-call', tool: 'Bash', description: 'remote background task', observedAt: 1 }]
    } }] : [])
  ]
})
const question = { runId: firstScryRun, questionId: 'fixture-question', providerId: 'claude', source: 'fixture', questions: [{
  question: '继续远程运行？', header: '确认', options: [{ label: '继续', description: '继续执行' }], multiSelect: false, allowCustomAnswer: false
}] }
const api = {
  async list() { if (state.listFailure) throw new Error('fixture connection read failed'); return [{ ...connection, state: state.connected ? 'connected' : 'disconnected' }] },
  async pair() { throw new Error('pairing is outside this fixture') },
  async finishPairing() { throw new Error('pairing is outside this fixture') },
  async updateSsh(id, ssh) {
    state.updateSshCalls.push({ id, ssh })
    if (state.updateFailure) throw new Error('fixture secure storage failure')
    if (state.holdAddressUpdate) await new Promise(resolve => { window.releaseAddressUpdate = resolve })
    connection.ssh = { ...ssh }
    state.connected = false
  },
  async connect() { state.connectCalls++; state.connected = true },
  async disconnect() { state.connected = false },
  async forget() {},
  async catalog() {
    state.catalogCalls++
    if (state.catalogFailure) throw new Error('fixture catalog unavailable')
    return structuredClone({ ...catalog,
      projects: catalog.projects.map(project => ({ ...project, label: project.label + (state.catalogRevision ? ' v2' : '') })),
      sessions: catalog.sessions.map(session => session.externalSessionId === 'old-native' ? { ...session, isActive: state.sessionActive, ts: state.sessionTs } : session),
      providers: (state.hideProvider ? [beta] : catalog.providers).map(provider => state.legacyProviderHost ? provider
        : ({ id: provider.id, label: provider.label, available: provider.available, observedAt: state.providerMetadataObservedAt, metadataRevision: state.providerMetadataRevision, ...(provider.forkSession === true ? { forkSession: true } : {}), ...(provider.agentProfileId ? { agentProfileId: provider.agentProfileId } : {}) })),
      providerDiscovery: state.legacyProviderHost ? undefined : 2,
      providerEvidence: state.legacyProviderHost ? 'legacy_host' : 'host_snapshot',
      directorySelection: state.oldDirectoryHost ? undefined : true
    })
  },
  async providerControls(id, context) {
    state.providerControlsCalls.push({ id, context: contextFor({ context }) })
    if (state.holdProviderControls) await new Promise(resolve => state.providerControlWaiters.push(resolve))
    const match = catalog.providers.find(provider => provider.id === context.providerId && (provider.agentProfileId ?? '') === (context.agentProfileId ?? ''))
    if (!match || state.providerControlsFailure === 'throw') throw new Error('fixture provider controls unavailable')
    return structuredClone(state.providerControlsFailure === 'unavailable' ? { id: match.id, label: match.label, available: false } : { ...match, observedAt: state.providerControlsObservedAt })
  },
  async commands(id, context) {
    state.commandCalls.push({ id, context })
    if (state.holdCommands) await new Promise(resolve => { window.releaseCommands = resolve })
    if (state.commandFailure) throw new Error('fixture host commands unavailable')
    return { commands: [{ name: 'skill:host-only', description: 'Skill from the remote host' }] }
  },
  async sessionAction(id, context, action) {
    state.sessionActions.push({ id, context, action })
    const session = catalog.sessions.find(item => item.externalSessionId === context.externalSessionId && item.cwd === context.cwd && item.providerId === context.providerId)
    if (!session) throw new Error('remote session mismatch')
    if (action.kind === 'rename') session.label = action.title
    if (action.kind === 'pin') session.pinnedAt = action.pinned ? Date.now() : undefined
    if (action.kind === 'archive') session.archivedAt = action.archived ? Date.now() : undefined
    return true
  },
  async forkSession(id, request) {
    state.forks.push({ id, request })
    catalog.sessions.push({ sessionId: 'forked-native', externalSessionId: 'forked-native', providerId: request.providerId, cwd: request.cwd, label: 'Forked session', ts: Date.now() })
    return { externalSessionId: 'forked-native' }
  },
  async deleteSession(id, request) {
    state.deletions.push({ id, request })
    if (state.deleteFailure) throw new Error('fixture deletion failed')
    const index = catalog.sessions.findIndex(item => item.externalSessionId === request.externalSessionId && item.archivedAt)
    if (index < 0 || request.confirmed !== true) throw new Error('not archived or confirmed')
    catalog.sessions.splice(index, 1)
    return { ok: true, deleted: [], failed: [] }
  },
  async directories(id, path = '/fixture/home', cursor = 0, snapshot) {
    state.directoryReads.push({ id, path, cursor, snapshot })
    if (!['/fixture/home', '/fixture/home/custom', '/fixture/home/empty'].includes(path)) throw new Error('directory_unavailable')
    const directories = path === '/fixture/home' ? [{ path: '/fixture/home/custom', label: 'custom' }, { path: '/fixture/home/empty', label: 'empty' }, { path: '/fixture/home/other', label: 'other' }] : []
    const end = Math.min(cursor + 2, directories.length)
    return { current: { path, label: path.split('/').pop() }, parent: { path: '/fixture/home', label: 'home' }, directories: directories.slice(cursor, end), cursor: end, total: directories.length, hasMore: end < directories.length, snapshot: 'a'.repeat(64) }
  },
  async selectDirectory(id, path) {
    state.directorySelectCalls.push({ id, path })
    if (state.selectDirectoryFailure) throw new Error('fixture directory grant not confirmed')
    if (state.holdDirectorySelection) await new Promise(resolve => { window.releaseDirectorySelection = resolve })
    const project = { path, label: path.split('/').pop() }
    state.directoryGrants.push(project)
    if (!catalog.projects.some(item => item.path === path)) catalog.projects.push(project)
    return project
  },
  async history(_id, context) {
    state.historyCalls.push(contextFor({ context }))
    if (state.holdHistory) await new Promise(resolve => { window.releaseHistory = resolve })
    if (${openingOnly || measureOpening}) return { turns: [{ runId: 'opening-history', userText: 'Long remote history', done: true, items: [
      { id: 'opening-answer', runId: 'opening-history', ts: '2026-10-19T12:00:00.000Z', kind: 'model', stage: 'text', text: Array.from({ length: 80 }, (_, i) => 'Remote history paragraph ' + i).join('\\n\\n') }
    ] }], hasOlder: false, source: 'trace_archive', status: 'available' }
    // A run typed on the host's own UI becomes history once it leaves the live set.
    if (state.hostRunArchived && context.externalSessionId === 'old-native') return { turns: [{ ...activeRun('run-hostui-1', 'old-native', 'host ui continue'), done: true }], hasOlder: false, source: 'trace_archive', status: 'available' }
    const turns = ${composerHistoryOnly} && context.externalSessionId === 'old-native'
      ? state.historyPrompts.map((userText, index) => ({ runId: 'history-' + index, userText, items: [], done: true }))
      : state.firstIntentCleared && context.externalSessionId === 'native-session'
      ? [{ runId: firstScryRun, userText: 'archived terminal turn', items: [], done: true }]
      : ${lifecycleOnly} && context.externalSessionId === 'old-native'
        ? [{ runId: 'old-run', providerTurnId: 'old-provider-turn', forkTurnId: 'old-fork-turn', userText: 'Fork boundary', items: [], done: true }] : []
    return { turns, hasOlder: false, source: 'trace_archive', status: 'available' }
  },
  async trace(_id, context, runId) {
    state.traceCalls.push({ context: contextFor({ context }), runId })
    if (context.cwd !== '/fixture/project-a') throw new Error('fixture trace context mismatch: ' + context.cwd)
    if (runId === firstScryRun && state.firstIntentCleared) throw new Error('terminal trace unavailable')
    if (runId === firstScryRun) return activeRun(firstScryRun, 'native-session', 'first remote run', question)
    if (runId === secondScryRun) return activeRun(secondScryRun, 'native-session', 'second remote run', undefined, true)
    if (runId === 'run-hostui-1') return activeRun('run-hostui-1', 'old-native', 'host ui continue')
    return null
  },
  async intents() {
    state.intentsCalls++
    return structuredClone(state.intent ? [state.intent] : [])
  },
  async submit(_id, input) {
    state.submitInputs.push(input)
    if (state.autoResetOnSubmit) state.runState = 'dispatched'
    if (state.holdSubmit) await new Promise(resolve => { window.releaseSubmit = resolve })
    const first = state.submitInputs.length === 1
    state.intent = { intentId: first ? 'intent-first' : 'intent-second', connectionId: connection.id, context: contextFor(input), createdAt: state.submitInputs.length, status: 'recorded', runId: first ? firstLedger : secondLedger }
    return structuredClone(state.intent)
  },
  async intentStatus() { return structuredClone(state.intent) },
  async runStatus(_id, runId) {
    if (state.holdRunStatus) await new Promise(resolve => { window.releaseRunStatus = resolve })
    if (state.runStatusFailure) throw new Error('desktop_remote_output_capture_queue_full')
    if (state.answerFailure && runId === firstLedger) {
      state.firstIntentCleared = true; state.intent = null
      return { state: 'failed', scryRunId: firstScryRun, externalSessionId: 'native-session' }
    }
    if (state.runState !== 'dispatched' || !state.exposeTrace) {
      if (state.runState === 'settled' || state.runState === 'failed') state.intent = null
      return { state: state.runState }
    }
    if (state.intent && !state.intent.context.externalSessionId) {
      state.intent.context.externalSessionId = 'native-session'
      if (!catalog.sessions.some(session => session.externalSessionId === 'native-session')) catalog.sessions.push({
        sessionId: 'native-session', externalSessionId: 'native-session', ...state.intent.context, label: 'Adopted remote session', ts: Date.now()
      })
    }
    if (runId === firstLedger) return { state: 'dispatched', scryRunId: firstScryRun, externalSessionId: 'native-session', detail: 'fixture dispatched' }
    return { state: 'dispatched', scryRunId: secondScryRun, externalSessionId: 'native-session', detail: 'fixture background work' }
  },
  // Host-UI run on old-native: present only while the catalog marks it active.
  async liveRun(_id, context) {
    state.liveRunCalls++
    return state.sessionActive && context.externalSessionId === 'old-native' ? { runId: 'run-hostui-1', origin: 'mac', state: 'running', scryRunId: 'run-hostui-1' } : null
  },
  async stop(_id, runId) { state.stopCalls.push(runId) },
  async answer(_id, runId, response) { state.answerCalls.push({ runId, response }); state.answerFailure = true; throw new Error('remote answer rejected') },
  async files(id, context, path = '', cursor) {
    state.fileLists.push({ id, context, path, cursor })
    const entry = (name, kind, parent = '') => ({ name, kind, path: parent ? parent + '/' + name : name, mtimeMs: 1 })
    return path === 'src'
      ? { entries: [entry('nested.txt', 'file', 'src')], truncated: false }
      : cursor ? { entries: [entry('image.png', 'file'), entry('small.md', 'file')], truncated: false }
      : { entries: [entry('src', 'directory'), entry('README.md', 'file')], truncated: true, nextCursor: 'remote-next' }
  },
  async file(id, context, path, offset = 0, snapshot) {
    state.fileReads.push({ id, context, path, offset, snapshot })
    if (path === 'image.png') throw new Error('SCRY_FILE_PREVIEW_UNSUPPORTED')
    if (path === 'small.md') return { name: path, path, content: '# Remote markdown', offset: 0, nextOffset: 17, totalBytes: 17, hasMore: false, snapshot: 'small-snapshot', language: 'markdown' }
    return { name: path.split('/').pop(), path, content: offset ? 'second remote page' : 'first remote page',
      offset, nextOffset: offset ? 34 : 17, totalBytes: 34, hasMore: !offset, snapshot: 'remote-snapshot', language: 'text' }
  }
}
const noopSubscribe = () => () => {}
window.scry = {
  // Same minimal full-App bridge contract as session-selection-smoke.tsx.
  activeRun: async () => null, activeRuns: async () => [],
  onTrace: noopSubscribe, onTurnDone: noopSubscribe, onError: noopSubscribe,
  listProjects: async () => [
    { cwd: '/fixture/pinned', name: 'Pinned local', pinnedAt: 1, mtime: 1, sessions: [] },
    { cwd: '/fixture/recent', name: 'Recent local', mtime: 1700000001000, sessions: [] },
    { cwd: '/fixture/older', name: 'Older local', mtime: 1699999999000, sessions: [] }
  ],
  listArchivedSessions: async () => [],
  recentFolders: async () => Array.from({ length: 12 }, (_, index) => '/fixture/recent-' + index),
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => [], listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  listCommands: async () => ({ state: 'ready', data: [{ name: 'skill:local-only', description: 'Local skill must never appear remotely' }] }),
  usageStats: async () => null, stats: async () => null, focusRun: async () => true,
  newSession: async () => { state.localNewSessions++; return true },
  start: async () => { state.localStarts++; throw new Error('Local execution must not be reached') },
  remoteStatus: async () => {
    if (state.phoneStatusFailure) throw new Error('fixture phone status unavailable')
    return state.phoneEnabled ? { enabled: true, hostId: 'local-host', anchorSHA256: 'local-anchor', relayConfigured: state.relayConfigured,
      pending: [], devices: [{ deviceId: 'phone', deviceLabel: 'Fixture iPhone', confirmedAt: 1, expiresAt: 4102444800000, revoked: false }] } : { enabled: false }
  },
  remoteBeginPairing: async () => { state.phonePairingCalls++; return { pairingId: 'fixture-pairing', secret: 'fixture-secret', hostId: 'local-host', anchorSHA256: 'local-anchor', expiresAt: Date.now() + 120000, deviceCode: 'scry1:fixture' } },
  copyText: async () => {},
  clipboardImage: async () => { state.clipboardImageCalls++; return { kind: 'image', name: 'clipboard.png', mimeType: 'image/png', dataBase64: 'aQ==', size: 1 } },
  desktopRemote: api, stopBackgroundTask: async () => { state.backgroundStopCalls++; return { status: 'unavailable', message: 'fixture remote task stop trap' } },
  async remoteDesktopHostStatus() { return state.hostEnabled ? { enabled: true, pairPort: 10001, runPort: 10002 } : { enabled: false } },
  async remoteDesktopHostInvite() { state.hostInviteCalls++; state.hostEnabled = true; return 'scry-desktop1:fixture' },
  async remoteDesktopHostDisable() { state.hostDisableCalls++; state.hostEnabled = false }
}
for (const method of ['workspaceList', 'workspaceRead', 'workspaceReadKnown', 'workspaceReadPage', 'workspaceReadPageKnown', 'workspaceOpenExternal', 'workspaceOpenKnownExternal', 'workspaceWrite', 'workspaceCreate', 'workspaceRename', 'workspaceMove', 'workspaceTrash']) {
  window.scry[method] = async () => { state.localWorkspaceCalls.push(method); throw new Error('Local workspace must not be reached: ' + method) }
}
window.desktopRemoteFixture = state
window.refreshFixtureCatalog = () => refreshRemoteCatalog(connection.id)
window.refreshFixtureConnections = refreshDesktopConnections
for (const type of ['keydown', 'change', 'mousedown', 'click']) document.addEventListener(type, event => {
  state.uiEvents.push({ type, key: event.key, value: event.target.value, tag: event.target.tagName, text: event.target.textContent?.slice(0, 100) })
  if (state.uiEvents.length > 24) state.uiEvents.shift()
}, true)
function Fixture() {
  const [fullApp, setFullApp] = useState(false)
  if (fullApp) return <App />
  return <><RemoteHostPanel />
    <button data-app-fixture style={{ position: 'fixed', top: 2, right: 2, zIndex: 9999 }} onClick={() => { state.intent = null; setFullApp(true) }}>Full App</button>
  </>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`

async function exercise(contents, pointer, capture, options) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression, label = expression) => {
    const deadline = Date.now() + 7000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}; DOM=${await read('JSON.stringify({ focus: document.activeElement?.tagName, selects: [...document.querySelectorAll("select")].map(node => ({value:node.value, options:[...node.options].map(option => ({text:option.text, value:option.value}))})), text: document.body.innerText.slice(-2000), events: window.desktopRemoteFixture.uiEvents })')}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const pointFor = (selector, text, captureReceipt = false) => read(`(${pointer.toString()})(${JSON.stringify(selector)}, { text: ${JSON.stringify(text ?? '')}, timeoutMs: 7000, scroll: true, captureReceipt: ${captureReceipt} })`)
  const send = (method, params) => contents.debugger.sendCommand(method, params)
  const click = async (selector, text) => {
    const point = await pointFor(selector, text, true)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await wait('window.__nativeUiPointerReceipt != null', 'native pointer receipt')
    const receipt = await read('window.__nativeUiPointerReceipt')
    check(receipt.trusted && receipt.targetMatched, `Native pointer missed ${selector}: ${JSON.stringify(receipt)}`)
  }
  const key = async (key, code = key, modifiers = 0) => {
    const virtualKey = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Backspace' ? 8 : key === 'ArrowDown' ? 40 : key === 'ArrowUp' ? 38 : key.length === 1 ? (key.charCodeAt(0) < 128 ? key.toUpperCase().charCodeAt(0) : 0) : undefined
    const nativeVirtualKeyCode = process.platform === 'darwin'
      ? { Enter: 36, Escape: 53, Backspace: 51, ArrowDown: 125, ArrowUp: 126, b: 11, f: 3 }[key]
      : virtualKey
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
    if (key.length === 1) await send('Input.dispatchKeyEvent', { type: 'char', key, text: key, unmodifiedText: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
  }
  const insert = (text) => send('Input.insertText', { text })
  const pasteImage = async () => read(`(async () => { const input = document.querySelector('textarea[aria-label="描述任务"]'); const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2; const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); const transfer = new DataTransfer(); transfer.items.add(new File([png], 'pasted.png', { type: 'image/png' })); input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); return true })()`)
  // Native forms submit on Enter's keypress/default action, not keydown alone.
  const formEnter = async () => {
    const event = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: process.platform === 'darwin' ? 36 : 13 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }

  const fixture = () => read('window.desktopRemoteFixture')
  const bodyText = () => read('document.body.textContent')

  await wait('document.querySelector(".desktop-remote__host button")?.textContent.includes("启用")', 'disabled host enable action')
  await click('.desktop-remote__host button')
  await wait('document.querySelector(".desktop-remote__invite")?.textContent.includes("scry-desktop1:fixture")', 'enabled host invitation')
  check((await fixture()).hostInviteCalls === 1, 'Host enable dispatched more than one invitation')
  check(await read('document.querySelector(".hosts-add-modal").textContent.includes("新邀请会使旧的未完成邀请失效")'), 'Invitation lost invalidation consequence')
  await click('button[aria-label="关闭 SSH 邀请"]')
  await click('.desktop-remote__host button:last-child')
  await wait('window.desktopRemoteFixture.hostDisableCalls === 1 && !document.querySelector(".desktop-remote__invite")', 'disable clears invitation')

  // Full production App: the remote session uses the same ChatView as local sessions.
  await click('[data-app-fixture]')
  const remoteShown = 'document.querySelector(".execution-location.is-remote") != null'
  const sendDisabled = 'document.querySelector(".runtime-composer button.send").disabled'
  const composerValue = 'document.querySelector(\'textarea[aria-label="描述任务"]\').value'
  await wait('document.querySelector(".sb-remote-proj") != null', 'connected remote project')
  check(!(await read('document.querySelector(".sb-hosts")')), 'Legacy hosts navigation remains')
  await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.textContent === "Fixture desktop"', 'remote project tagged with host in sidebar')
  await wait('document.querySelector(".location-button") != null', 'machine + project picker in composer')
  if (options.openingOnly || options.measureOpening) {
  // Selected controls are demand-loaded. A delayed response for a previous
  // session Provider must not publish after the user switches context.
  await read('window.desktopRemoteFixture.holdProviderControls = true')
  await click('[data-remote-session="other-native"]')
  await wait('window.desktopRemoteFixture.providerControlsCalls.some(call => call.context.providerId === "qoder")', 'selected Beta controls request')
  await click('[data-remote-session="old-native"]')
  await wait('window.desktopRemoteFixture.providerControlsCalls.some(call => call.context.providerId === "claude")', 'selected Alpha controls request after switch')
  await read('window.desktopRemoteFixture.providerControlWaiters.shift()()')
  await wait('window.desktopRemoteFixture.providerControlsCalls.at(-1)?.context.providerId === "claude"', 'selected Alpha context after switch')
  check(!await read('document.querySelector(".chat")?.textContent.includes("Beta Default")'), 'Stale Provider controls were published')
  await read('window.desktopRemoteFixture.holdProviderControls = false; window.desktopRemoteFixture.providerControlWaiters.splice(0).forEach(resolve => resolve())')
  await wait('document.querySelector(".model-effort-model")?.textContent === "Alpha Default"', 'selected controls settle after stale switch')
  await read('window.desktopRemoteFixture.providerControlsFailure = "unavailable"')
  await click('[data-remote-session="other-native"]')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("未能读取所选 Provider")', 'unavailable controls are visible')
  await click('textarea[aria-label="描述任务"]'); await insert('control-load-check')
  check(await read(sendDisabled), 'Unavailable controls enabled send')
  await read('window.desktopRemoteFixture.providerControlsFailure = null')
  await click('.composer-notice button')
  await wait('!document.querySelector(".runtime-composer button.send").disabled', 'explicit controls retry restores send')
  await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await key('Backspace')
  const beforeLegacy = (await fixture()).providerControlsCalls.length
  await read('window.desktopRemoteFixture.legacyProviderHost = true')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("旧版主机能力快照")', 'negotiated legacy snapshot is labelled')
  await click('textarea[aria-label="描述任务"]'); await insert('legacy-control-check')
  await wait('!document.querySelector(".runtime-composer button.send").disabled', 'legacy host preserves its existing send contract')
  check((await fixture()).providerControlsCalls.length === beforeLegacy, 'Legacy host received a selected-controls query')
  await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await key('Backspace')
  await read('window.desktopRemoteFixture.legacyProviderHost = false')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeLegacy, 'new-host selected lookup resumes after negotiation')
  await wait('document.querySelector(".model-effort-model")?.textContent === "Beta Default"', 'new-host controls restored')
  if (options.openingOnly) {
  await wait('document.querySelector(".composer-notice")?.textContent.includes("主机读取于")', 'selected host observation time')
  const readLabel = await read('document.querySelector(".composer-notice span").textContent')
  const beforeMetadataRefresh = (await fixture()).providerControlsCalls.length
  await read('window.desktopRemoteFixture.providerControlsObservedAt += 1000; window.desktopRemoteFixture.providerMetadataRevision += 1')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeMetadataRefresh, 'same-context metadata invalidates selected controls')
  await wait('document.querySelector(".composer-notice span")?.textContent !== ' + JSON.stringify(readLabel) + ' && !document.querySelector(".composer-notice button").disabled', 'selected observation time advances')
  check(await read('document.querySelector(".model-effort-model")?.textContent === "Beta Default"'), 'Refresh silently changed selected model')
  const beforeManualRefresh = (await fixture()).providerControlsCalls.length
  await click('.composer-notice button')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeManualRefresh, 'successful controls remain explicitly refreshable')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("主机读取于") && !document.querySelector(".composer-notice button").disabled', 'manual refresh settles')
  await click('textarea[aria-label="描述任务"]'); await insert('same-context-observation')
  await wait('!document.querySelector(".runtime-composer button.send").disabled', 'known selected snapshot can send')
  await read('window.desktopRemoteFixture.providerControlsFailure = "throw"')
  await click('.composer-notice button')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("未能读取所选 Provider")', 'failed reread discards old successful catalog')
  check(await read(sendDisabled), 'Failed reread silently reused old controls')
  await read('window.desktopRemoteFixture.providerControlsFailure = null')
  await click('.composer-notice button')
  await wait('!document.querySelector(".runtime-composer button.send").disabled', 'same-context retry restores valid choices')
  await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await key('Backspace')
  const beforeFocus = (await fixture()).providerControlsCalls.length
  check(await read('document.visibilityState === "visible"'), 'Focus control requires unchanged visible state')
  await read('window.dispatchEvent(new Event("focus"))')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeFocus, 'visible window focus rereads selected controls')
  await wait('!document.querySelector(".composer-notice button").disabled', 'focused controls settle')
  const beforeHidden = (await fixture()).providerControlsCalls.length
  const catalogBeforeHidden = (await fixture()).catalogCalls
  await read('Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); window.desktopRemoteFixture.providerMetadataRevision += 1')
  await wait('window.desktopRemoteFixture.catalogCalls > ' + catalogBeforeHidden, 'hidden metadata observation')
  check((await fixture()).providerControlsCalls.length === beforeHidden, 'Hidden composer initialized a Provider')
  await read('delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange"))')
  await wait('window.desktopRemoteFixture.providerControlsCalls.length > ' + beforeHidden, 'visible composer reobserves its selected controls')
  }
  await click('.sb-new')
  await wait('document.querySelector(".location-button") != null', 'new remote draft after stale switch')
  }
  if (options.openingOnly || options.measureOpening) {
    const bottom = '(() => { const el = document.querySelector(".chat"); return el && el.scrollHeight - el.scrollTop - el.clientHeight <= 2 })()'
    const samples = []
    const wheelUp = async () => {
      const point = await pointFor('.chat')
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -10000 })
      await wait('document.querySelector(".chat").scrollTop < document.querySelector(".chat").scrollHeight - document.querySelector(".chat").clientHeight - 64', 'native upward scroll leaves latest')
    }
    for (let index = 0; index < 5; index++) {
      if (index > 0) await wheelUp()
      const before = await fixture()
      await read('window.openingPreviousChat = document.querySelector(".chat"); window.openingStartedAt = performance.now()')
      const session = index % 2 ? 'other-native' : 'old-native'
      await click(`[data-remote-session="${session}"]`)
      await wait('document.querySelector(".chat") !== window.openingPreviousChat && document.querySelector(".chat")?.textContent.includes("Remote history paragraph 79")', 'bounded remote history renders')
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const elapsedMs = await read('performance.now() - window.openingStartedAt')
      const after = await fixture()
      samples.push({ elapsedMs, historyRequests: after.historyCalls.length - before.historyCalls.length,
        commandRequests: after.commandCalls.length - before.commandCalls.length, catalogRequests: after.catalogCalls - before.catalogCalls })
      if (options.openingOnly) {
        await wait(bottom, 'each selected remote session opens at the latest message')
      }
    }
    if (options.openingOnly) {
      check(samples.every(sample => sample.commandRequests === 0), 'Opening history eagerly queried Provider commands')
      await read('window.desktopRemoteFixture.holdHistory = true')
      await click('[data-remote-session="other-native"]')
      await wait('typeof window.releaseHistory === "function"', 'history request held in flight')
      check(!await read('document.querySelector(".chat").textContent.includes("Remote history paragraph 79")'), 'Previous history leaked into the loading context')
      await read('window.desktopRemoteFixture.holdHistory = false; window.releaseHistory(); delete window.releaseHistory')
      await wait('document.querySelector(".chat").textContent.includes("Remote history paragraph 79")', 'delayed history resolves')
      await wait(bottom, 'delayed history opens at bottom')
      await read('const extra = document.createElement("div"); extra.dataset.openingResize = "true"; extra.style.height = "900px"; document.querySelector(".chat").append(extra)')
      await wait(bottom, 'late history layout remains at bottom')
      await wheelUp()
      const position = await read('document.querySelector(".chat").scrollTop')
      await read('document.querySelector("[data-opening-resize]").style.height = "1200px"')
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      check(await read(`Math.abs(document.querySelector(".chat").scrollTop - ${position}) < 2`), 'Remote layout pulled the reader away from older messages')
      await click('textarea[aria-label="描述任务"]'); await insert('/skill')
      await wait('document.querySelector(".slash-item")?.textContent.includes("skill:host-only")', 'slash commands still load on demand')
      check((await fixture()).commandCalls.length === 1, 'Slash query was duplicated across remote opens')
    }
    return { remoteSessionOpening: { samples, nativeSelection: true, nativeScroll: true, bottomChecked: options.openingOnly,
      noLocalExecution: (await fixture()).localStarts === 0, onDemandCommands: options.openingOnly } }
  }
  await click('textarea[aria-label="描述任务"]'); await insert('settings keeps this draft')
  await click('.location-button'); await click('.location-menu .mitem', '管理远程访问')
  await wait('document.querySelector(".settings-tab.active")?.textContent.includes("远程访问") && document.querySelector(".remote-connections-settings") != null', 'manage hosts opens remote settings directly')
  check(await read(`${composerValue} === 'settings keeps this draft'`), 'Opening settings replaced the current draft')
  check(await read('document.activeElement === document.querySelector(".settings-tab.active")'), 'Direct settings entry did not focus the remote tab')
  if (options.settingsOnly) {
    await wait('document.querySelector(".remote-access-inbound").textContent.includes("Fixture iPhone")', 'phone grant in focused settings')
    await capture('remote-settings-focused')
    await click('.remote-access-header button')
    await wait('document.querySelector(".hosts-add-modal") != null', 'nested add-host dialog')
    await key('Tab')
    check(await read('document.querySelector(".hosts-add-modal").contains(document.activeElement)'), 'Nested dialog lost keyboard focus')
    await key('Escape')
    await wait('!document.querySelector(".hosts-add-modal") && document.querySelector(".settings-modal") != null', 'Escape closes only the nested dialog')
    check(await read('document.activeElement === document.querySelector(".remote-access-header button")'), 'Nested dialog did not restore action focus')
    await click('.remote-access-card:not(.desktop-remote__host) button')
    await wait('document.querySelector(".remote-pairing__qr canvas") != null', 'phone code opens a nested dialog')
    check(await read('document.querySelector(".hosts-add-modal").textContent.includes("2 分钟内有效") && document.querySelector(".hosts-add-modal").textContent.includes("核对连接设备上的公钥指纹")'), 'Phone pairing lost expiry or fingerprint guidance')
    await key('Escape')
    check(await read('document.querySelector(".settings-modal") != null && !document.querySelector(".hosts-add-modal")'), 'Closing phone code closed settings too')
    await read('window.desktopRemoteFixture.phoneStatusFailure = true')
    await wait('document.querySelector(".remote-access-inbound").textContent.includes("状态未知") && document.querySelector(".remote-access-inbound").textContent.includes("fixture phone status unavailable")', 'unread phone status stays unknown')
    check(!(await read('document.querySelector(".remote-device-section")')), 'Failed phone read claimed no devices or kept current grants')
    await read('window.desktopRemoteFixture.phoneStatusFailure = false; window.desktopRemoteFixture.relayConfigured = false')
    await wait('document.querySelector(".remote-access-inbound").textContent.includes("中继休眠") && document.querySelector(".remote-device-section") != null', 'dormant phone relay with preserved grants')
    await read('window.desktopRemoteFixture.phoneEnabled = false')
    await wait('document.querySelector(".remote-access-card:not(.desktop-remote__host)").textContent.includes("未启用") && !document.querySelector(".remote-access-card:not(.desktop-remote__host) button")', 'disabled phone access has no pairing action')
    await read('window.desktopRemoteFixture.phoneEnabled = true; window.desktopRemoteFixture.relayConfigured = true')
    await wait('document.querySelector(".remote-access-card:not(.desktop-remote__host)").textContent.includes("中继已配置")', 'phone status recovers')
    return { remoteSettingsInteractions: { directEntryKeepsDraft: true, nestedDialogKeyboard: true, phoneExpiryAndFingerprint: true, phoneUnknownDormantDisabled: true }, nativeCoordinateInput: true }
  }
  await click('.settings-modal .modal-x')
  check(await read('document.activeElement === document.querySelector(".location-button")'), 'Closing settings did not return focus to the location picker')
  await click('textarea[aria-label="描述任务"]'); await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await key('Backspace')
  const projectOrder = () => read('Array.from(document.querySelectorAll(".sb-proj .pname"), node => node.textContent)')
  check(JSON.stringify(await projectOrder()) === JSON.stringify(['Pinned local', 'Recent local', 'Project A', 'Older local', 'Project B']), 'Remote project was appended instead of sorted by recent activity')
  check(!(await read('document.querySelector(".sb-remote-proj .sb-running")')), 'Idle remote session appeared active')
  if (!options.parityOnly && !options.lifecycleOnly && !options.composerHistoryOnly) {
    // Host-side activity changes while the user stays in the local composer.
    // No explicit refresh: the shared loader must observe starts and stops itself.
    await read('window.desktopRemoteFixture.sessionActive = true; window.desktopRemoteFixture.sessionTs = 1700000002000')
    await wait('document.querySelector(".sb-remote-proj .sb-sess.running .sb-running") != null', 'background remote session shows a running spinner')
    check(JSON.stringify(await projectOrder()) === JSON.stringify(['Pinned local', 'Project A', 'Recent local', 'Older local', 'Project B']), 'Remote activity did not move its project up while preserving local pins')
    check(await read('getComputedStyle(document.querySelector(".sb-remote-proj .sb-running")).animationName === "sb-running-spin"'), 'Remote activity did not reuse the local spinner animation')
    await capture('remote-sidebar-running')
    await click('.sb-view-tabs [role=tab]', '动态')
    await wait('document.querySelector(".sb-activity [data-remote-session=old-native]") != null', 'live remote session appears in activity tab')
    check(await read('document.querySelectorAll(".sb-activity [data-remote-session=old-native]").length === 1'), 'Activity duplicated a remote session')
    check(await read('document.querySelector(".sb-activity [data-activity-group=working] .sb-host-tag")?.textContent === "Fixture desktop"'), 'Activity lost the owning host')
    check(!await read('document.querySelector(".sb-activity .sb-proj-head")'), 'Activity inserted project headers into the flat session list')
    await click('.sb-search input'); await insert('Fixture desktop')
    await wait('document.querySelector(".sb-activity [data-remote-session=old-native]") != null', 'activity searches remote host labels')
    await read('document.querySelector(".sb-search input").select()'); await key('Backspace')
    await click('.sb-activity [data-remote-session="old-native"]')
    await wait(remoteShown, 'activity selection opens the owning remote session')
    check((await fixture()).localStarts === 0 && (await fixture()).submitInputs.length === 0, 'Activity selection executed a turn')
    // The run was started on the host UI: no receipt here, yet the open session follows it.
    await wait('document.querySelector(".chat-transcript")?.textContent.includes("host ui continue")', 'host-started run streams into the opened remote session')
    check((await fixture()).intentsCalls > 0 && (await fixture()).liveRunCalls > 0, 'Foreign run was not discovered through the host live set')
    await capture('remote-activity-tab')
    await read('window.desktopRemoteFixture.catalogFailure = true')
    await wait('!document.querySelector(".sb-activity [data-remote-session=old-native]")', 'failed catalog removes cached live activity')
    await click('.sb-view-tabs [role=tab]', '项目')
    await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.dataset.state === "unknown"', 'failed catalog read invalidates live activity')
    check(!(await read('document.querySelector(".sb-remote-proj .sb-running")')), 'Stale catalog still claimed a running remote session')
    check(await read('document.querySelector(".sb-remote-proj [data-remote-session=old-native]") != null'), 'Catalog failure discarded remote history')
    const historyReads = (await fixture()).historyCalls.length
    await read('window.desktopRemoteFixture.catalogFailure = false; window.desktopRemoteFixture.sessionActive = false; window.desktopRemoteFixture.hostRunArchived = true')
    await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.dataset.state === "connected"', 'catalog polling recovers')
    await wait(`window.desktopRemoteFixture.historyCalls.length > ${historyReads} && document.querySelector(".chat-transcript")?.textContent.includes("host ui continue")`, 'ended host run is re-read as history')
    check(!(await read('document.querySelector(".sb-remote-proj .sb-running")')), 'Settled background session retained its spinner')
    await click('.sb-view-tabs [role=tab]', '动态')
    check(!await read('document.querySelector(".sb-activity [data-remote-session]")'), 'Idle remote history was guessed to be completed')
    await click('.sb-view-tabs [role=tab]', '项目')
  }
  const projectAHead = '.sb-proj-head[aria-label="Project A · Fixture desktop · /fixture/project-a"]'
  await click(projectAHead)
  await wait(`document.querySelector(${JSON.stringify(projectAHead)}).getAttribute('aria-expanded') === 'false'`, 'remote project collapsed')
  await click('.sb-search input'); await insert('Project B')
  await wait('document.querySelectorAll(".sb-remote-proj").length === 1 && document.querySelector(".sb-remote-proj .pname")?.textContent === "Project B"', 'remote project filtered out')
  await read('document.querySelector(".sb-search input").select()'); await key('Backspace')
  await wait(`document.querySelector(${JSON.stringify(projectAHead)}) != null`, 'remote project restored after search')
  check(await read(`document.querySelector(${JSON.stringify(projectAHead)}).getAttribute('aria-expanded') === 'false'`), 'Search reset remote project collapse state')
  await click(projectAHead)
  // Remote workbenches must use the production shell, not an overlay drawer.
  await click('[data-remote-session="old-native"]')
  await wait(remoteShown, 'remote history selected for workspace checks')
  if (options.composerHistoryOnly) {
    await wait('document.querySelector(".chat-transcript")?.textContent.includes("latest remote prompt")', 'remote prompt history')
    await click('textarea[aria-label="描述任务"]')
    await key('ArrowUp')
    await wait(`${composerValue} === 'latest remote prompt'`, 'recall latest remote prompt')
    await wait('document.querySelector(\'[data-remote-session="old-native"] .sb-draft\') != null', 'remote session draft indicator')
    const refreshHistory = async (prompts) => {
      const reads = (await fixture()).historyCalls.length
      await read(`window.desktopRemoteFixture.historyPrompts = ${JSON.stringify(prompts)}; window.desktopRemoteFixture.connected = false; window.refreshFixtureConnections()`)
      await wait('document.querySelector(".composer-notice")?.textContent.includes("未连接")', 'history refresh disconnect')
      await read('window.desktopRemoteFixture.connected = true; window.refreshFixtureConnections()')
      await wait(`window.desktopRemoteFixture.historyCalls.length > ${reads} && !document.querySelector(".composer-notice:not(.is-info)")`, 'history refresh reconnect')
      await wait(`document.querySelector(".chat-transcript")?.textContent.includes(${JSON.stringify(prompts.at(-1))})`, 'updated remote history')
    }
    await refreshHistory(['older remote prompt', 'latest remote prompt', 'arrived while browsing'])
    await key('ArrowUp')
    await wait(`${composerValue} === 'older remote prompt'`, 'continue history after remote refresh')
    await key('ArrowDown')
    await wait(`${composerValue} === 'latest remote prompt'`, 'return through the original history snapshot')
    await key('ArrowDown')
    await wait(`${composerValue} === ''`, 'leave history at empty draft')
    await wait('document.querySelector(\'[data-remote-session="old-native"] .sb-draft\') == null', 'empty remote composer removes draft indicator')
    await key('ArrowUp')
    await wait(`${composerValue} === 'arrived while browsing'`, 'next traversal sees refreshed history')
    await key('ArrowDown')
    await refreshHistory(['older remote prompt', '/skill:host-only'])
    await key('ArrowUp')
    await wait(`${composerValue} === '/skill:host-only'`, 'recall slash prompt')
    check(!await read('document.querySelector(".slash-menu") != null'), 'History recall opened slash completion instead of history navigation')
    await key('ArrowUp')
    await wait(`${composerValue} === 'older remote prompt'`, 'slash prompt does not consume history arrows')
    await key('ArrowDown'); await key('ArrowDown')
    await insert('edited draft')
    await key('ArrowUp')
    check(await read(`${composerValue} === 'edited draft'`), 'History replaced a manually edited draft')
    await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()')
    await key('Backspace'); await insert('/skill')
    await wait('document.querySelector(".slash-menu") != null', 'typing still opens command completion')
    await key('Escape')
    await wait('document.querySelector(".slash-menu") == null', 'Escape closes typed command completion')
    await click('[data-remote-session="other-native"]')
    await wait(`${composerValue} === '' && document.querySelector(".chat-session-evidence-gap") != null`, 'switch to an empty remote session')
    await click('textarea[aria-label="描述任务"]'); await key('ArrowUp')
    check(await read(`${composerValue} === ''`), 'History leaked from another session')
    check(await read('document.querySelector(\'[data-remote-session="old-native"]:not(.active) .sb-draft\') != null && document.querySelector(\'[data-remote-session="other-native"] .sb-draft\') == null'), 'Remote draft indicator leaked or disappeared after switching')
    await click('[data-remote-session="old-native"]')
    await wait(`${composerValue} === '/skill'`, 'return to marked remote draft')
    check((await fixture()).localStarts === 0 && (await fixture()).submitInputs.length === 0, 'History browsing sent a prompt')
    return { remoteComposerHistory: { refreshDuringNavigation: true, slashRecall: true, typedSlashAndEscape: true, editedDraftPreserved: true, sessionIsolation: true, sidebarDraftPresence: true, nativeKeyboard: true } }
  }
  // Native input through production App: insertion must retain the owning host/session.
  await click('textarea[aria-label="描述任务"]'); await insert('remote draft')
  await read(`localStorage.setItem('scry.meta-prompts.v1', JSON.stringify([{id:'remote-meta',title:'Remote routing',body:'host scoped prompt'}]))`)
  await click('.sb-navitem', 'Meta Prompts')
  await wait('document.querySelector(".mp-button") != null', 'meta prompt library')
  await click('.mp-button', '放入当前会话')
  await wait(remoteShown, 'meta prompt returns to remote session, not local')
  await wait(`${composerValue} === 'remote draft\\n\\nhost scoped prompt'`, 'remote meta prompt preserves its draft')
  check((await fixture()).localStarts === 0 && (await fixture()).submitInputs.length === 0, 'Meta prompt unexpectedly sent')
  await click('.sb-navitem', '分析'); await click('.sb-navitem', 'Meta Prompts'); await click('.mp-button', '放入当前会话')
  await wait(`${composerValue} === 'remote draft\\n\\nhost scoped prompt\\n\\nhost scoped prompt'`, 'auxiliary views retain the remote insertion target')
  await click('textarea[aria-label="描述任务"]'); await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await insert('/skill')
  await wait('document.querySelector(".slash-item")?.textContent.includes("skill:host-only")', 'host-only slash completion')
  check(await read('document.querySelector(".slash-head")?.textContent.includes("Fixture desktop 上的命令")'), 'Remote command heading did not identify its host')
  check(await read('!document.querySelector(".slash-menu")?.textContent.includes("skill:local-only")'), 'Remote commands included the local catalog')
  await read('window.desktopRemoteFixture.commandFailure = true')
  await click('.slash-retry', '刷新')
  await wait('document.querySelector(".slash-empty")?.textContent.includes("fixture host commands unavailable")', 'remote command failure')
  check(await read('document.querySelectorAll(".slash-item").length === 0'), 'Failed host lookup kept stale/local commands')
  await read('window.desktopRemoteFixture.commandFailure = false; window.desktopRemoteFixture.holdCommands = true')
  await click('.slash-retry', '刷新')
  await wait('typeof window.releaseCommands === "function"', 'pending host command query')
  await read('window.desktopRemoteFixture.connected = false; window.refreshFixtureConnections()')
  await wait('!document.querySelector(".slash-head")?.textContent.includes("读取中") && document.querySelectorAll(".slash-item").length === 0', 'disconnected command catalog cleared')
  await read('window.releaseCommands(); Promise.resolve()')
  check(await read('document.querySelectorAll(".slash-item").length === 0'), 'Late host response repopulated a disconnected catalog')
  await read('window.desktopRemoteFixture.holdCommands = false; window.desktopRemoteFixture.connected = true; window.refreshFixtureConnections()')
  await wait('document.querySelector(".slash-item")?.textContent.includes("skill:host-only")', 'reconnected host command catalog')
  await click('textarea[aria-label="描述任务"]')
  await key('Enter')
  await wait(`${composerValue} === '/skill:host-only '`, 'keyboard slash selection')
  check((await fixture()).commandCalls.at(-1).id === 'fixture-connection' && (await fixture()).commandCalls.at(-1).context.cwd === '/fixture/project-a', 'Slash discovery used the wrong host/project')
  await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await key('Backspace')
  const remoteRowPoint = await pointFor('[data-remote-session="old-native"]')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...remoteRowPoint })
  await click('button[aria-label="置顶：Old session"]')
  await wait('document.querySelector(\'button[aria-label="取消置顶：Old session"]\')?.getAttribute("aria-pressed") === "true"', 'host session pinned')
  await click('button[aria-label="取消置顶：Old session"]')
  await wait('document.querySelector(\'button[aria-label="置顶：Old session"]\') != null', 'host session unpinned')
  await click('button[aria-label="会话操作：Old session"]'); await click('[role=menuitem]', '重命名')
  await wait('document.querySelector(".session-rename-dialog input") != null', 'remote rename dialog')
  await insert('Remote renamed'); await formEnter()
  await wait('document.querySelector(\'[data-remote-session="old-native"] .sb-sesstext\')?.textContent === "Remote renamed"', 'host rename readback')
  await click('button[aria-label="存档会话：Remote renamed"]')
  await wait('!document.querySelector(\'[data-remote-session="old-native"]\')', 'host archived row hidden')
  check(await read('!document.querySelector(".clibtn").disabled'), 'Archiving the active remote session did not leave it for a new draft')
  check(!await read('document.querySelector(".sb-archive-toggle")'), 'Archived remote sidebar entry remains')
  await click('.sb-settings')
  await click('.settings-tab', '已存档会话')
  await wait('document.querySelector(\'[data-archived-remote-session="old-native"]\') != null', 'archived session appears in settings')
  await click('button[aria-label="取消存档：Remote renamed"]')
  await wait('!document.querySelector(\'[data-archived-remote-session="old-native"]\')', 'restored session no longer archived')
  await click('button[aria-label="关闭设置"]')
  await wait('document.querySelector(\'[data-remote-session="old-native"]\') != null', 'restored host row visible')
  check((await fixture()).sessionActions.every(call => call.id === 'fixture-connection' && call.context.externalSessionId === 'old-native'), 'Session actions targeted local/wrong session')
  await click('[data-remote-session="old-native"]')
  await wait('document.querySelector(".clibtn").disabled', 'restored remote session selected')
  if (options.lifecycleOnly) {
    const hoverOld = async () => send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await pointFor('[data-remote-session="old-native"]') })
    await wait('document.querySelector(".turn-branch-btn") != null', 'verified remote fork boundary')
    await click('.turn-branch-btn')
    await wait('document.querySelector(\'[data-remote-session="forked-native"]\')?.classList.contains("active")', 'forked remote session selected')
    const forks = (await fixture()).forks
    const expectedFork = { providerId: 'claude', cwd: '/fixture/project-a', sourceSessionId: 'old-native', sourceRunId: 'old-run', sourceProviderTurnId: 'old-provider-turn', sourceForkTurnId: 'old-fork-turn', model: { id: 'alpha-default', providerId: 'claude' }, permissionMode: 'default' }
    check(forks.length === 1 && forks[0].id === 'fixture-connection' && Object.entries(expectedFork).every(([field, value]) => JSON.stringify(forks[0].request[field]) === JSON.stringify(value)), 'Fork did not preserve canonical host/session/turn identity: ' + JSON.stringify(forks))
    await hoverOld()
    await click('button[aria-label="存档会话：Remote renamed"]')
    await wait('!document.querySelector(\'[data-remote-session="old-native"]\')', 'archived remote session removed from sidebar')
    check(!await read('document.querySelector(".sb-archive-toggle")'), 'Sidebar still exposes archived remote sessions')
    await click('.sb-settings')
    await click('.settings-tab', '已存档会话')
    await wait('document.querySelector(\'[data-archived-remote-session="old-native"]\') != null', 'archived remote session listed in settings')
    check(await read('document.querySelector(".arch-head .arch-danger")?.textContent.includes("本机")'), 'Local bulk deletion does not name its scope')
    await capture('remote-archived-settings')
    await read('window.desktopRemoteFixture.connected = false; window.refreshFixtureConnections()')
    await wait('document.querySelector(\'button[aria-label="取消存档：Remote renamed"]\')?.disabled', 'offline restore disabled')
    check(await read('document.querySelector(\'button[aria-label="删除 Scry 副本"]\')?.disabled'), 'Offline deletion remained enabled')
    await read('window.desktopRemoteFixture.connected = true; window.refreshFixtureConnections()')
    await wait('document.querySelector(\'button[aria-label="取消存档：Remote renamed"]\')?.disabled === false', 'online restore enabled')
    await click('button[aria-label="取消存档：Remote renamed"]')
    await wait('!document.querySelector(\'[data-archived-remote-session="old-native"]\') && document.querySelector(\'[data-remote-session="old-native"]\') != null', 'restore returns session to sidebar')
    await key('Escape')
    await hoverOld()
    await click('button[aria-label="存档会话：Remote renamed"]')
    await wait('!document.querySelector(\'[data-remote-session="old-native"]\')', 'restored session can be archived again')
    await click('.sb-settings')
    await click('.settings-tab', '已存档会话')
    await wait('document.querySelector(\'[data-archived-remote-session="old-native"]\') != null', 'rearchived remote session in settings')
    await click('button[aria-label="删除 Scry 副本"]')
    await wait('Array.from(document.querySelectorAll(".modal-head")).some(node => node.textContent.includes("Fixture desktop"))', 'delete confirmation names remote host')
    await click('.modal-foot button', '取消')
    check((await fixture()).deletions.length === 0, 'Cancel deleted remote data')
    await click('button[aria-label="删除 Scry 副本"]')
    await read('window.desktopRemoteFixture.deleteFailure = true')
    await click('.modal-foot button', '删除 Scry 副本')
    await wait('document.querySelector(".arch-failures")?.textContent.includes("fixture deletion failed")', 'failed deletion is visible')
    check((await fixture()).deletions.length === 1, 'Failed deletion was retried automatically')
    await read('window.desktopRemoteFixture.deleteFailure = false')
    await click('button[aria-label="删除 Scry 副本"]')
    await click('.modal-foot button', '删除 Scry 副本')
    await wait('!document.querySelector(\'[data-archived-remote-session="old-native"]\')', 'deleted archived session removed after host acknowledgement')
    const calls = (await fixture()).deletions
    check(calls.length === 2 && calls.every(call => call.id === 'fixture-connection' && call.request.externalSessionId === 'old-native' && call.request.cwd === '/fixture/project-a' && call.request.confirmed === true), 'Deletion used the wrong remote authority')
    check((await fixture()).localStarts === 0 && (await fixture()).submitInputs.length === 0, 'Session operations sent a task')
    return { remoteSessionLifecycle: { forkBoundary: true, forkSelection: true, archiveRequired: true, settingsArchiveList: true, noSidebarArchiveEntry: true, restoreToSidebar: true, offlineDisabled: true, deleteConfirmation: true, cancelNoWrite: true, failureVisible: true, noAutomaticRetry: true, hostIdentity: true, noTaskSent: true } }
  }
  if (options.parityOnly) {
    await click('.sb-new')
    await wait(remoteShown, 'new remote session for adoption')
    await read('window.desktopRemoteFixture.autoResetOnSubmit = true; window.desktopRemoteFixture.holdRunStatus = true')
    await click('textarea[aria-label="描述任务"]'); await insert('first remote turn'); await key('Enter')
    await wait('document.querySelector(".run-status") != null && typeof window.releaseRunStatus === "function"', 'remote run active before native id arrives')
    await insert('queued remote turn'); await key('Enter')
    await wait('document.querySelector(".prompt-queue")?.textContent.includes("queued remote turn")', 'remote follow-up queued')
    check((await fixture()).submitInputs.length === 1, 'Queued message sent before terminal confirmation')
    await read('window.desktopRemoteFixture.holdRunStatus = false; window.releaseRunStatus()')
    await wait('window.desktopRemoteFixture.intent?.context.externalSessionId === "native-session"', 'host session binding')
    await read('window.refreshFixtureCatalog()')
    await wait('document.querySelector(\'[data-remote-session="native-session"]\') != null', 'adopted native session in sidebar')
    await read('window.desktopRemoteFixture.runStatusFailure = true')
    await wait('document.querySelector(".composer-notice")?.textContent.includes("output_capture_queue_full")', 'failed status read preserves queue')
    check((await fixture()).submitInputs.length === 1, 'Failed status read drained queue')
    await click('.sb-navitem', 'Meta Prompts'); await click('.mp-button', '放入当前会话')
    await wait(`${composerValue} === 'host scoped prompt'`, 'running remote meta prompt retains current session')
    check(await read('document.querySelector(".prompt-queue")?.textContent.includes("queued remote turn")'), 'Meta prompts lost remote queue')
    await click('.sb-navitem', '分析')
    await read('window.desktopRemoteFixture.connected = false; window.refreshFixtureConnections()')
    await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.getAttribute("data-state") === "disconnected"', 'background disconnect')
    await read('window.desktopRemoteFixture.connected = true; window.refreshFixtureConnections()')
    await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.getAttribute("data-state") === "connected"', 'background reconnect')
    await read('window.desktopRemoteFixture.runStatusFailure = false; window.desktopRemoteFixture.runState = "settled"')
    await click('[data-remote-session="native-session"]')
    await wait('document.querySelector(".composer-notice")?.textContent.includes("继续队列") && window.desktopRemoteFixture.intent === null', 'reopened adopted queue remains paused after terminal')
    check((await fixture()).submitInputs.length === 1, 'Background reconnect automatically sent queued input')
    await click('.composer-notice button', '继续队列')
    await wait('window.desktopRemoteFixture.submitInputs.length === 2', 'queue drains only after explicit continuation')
    check((await fixture()).submitInputs[1].prompt === 'queued remote turn' && (await fixture()).submitInputs[1].context.externalSessionId === 'native-session', 'Queued message lost adopted native session identity')
    check((await fixture()).localStarts === 0, 'Remote queue started local Provider')
    await wait('!document.querySelector(".prompt-queue")', 'queue entry removed after acknowledged submission')
    // Cancel the view while a terminal status read is pending: the receipt is
    // retired by main, but App-owned queued work must still consume its evidence.
    await click('textarea[aria-label="描述任务"]'); await read('document.querySelector(\'textarea[aria-label="描述任务"]\').select()'); await insert('terminal navigation race'); await key('Enter')
    await read('window.releaseRunStatus = null; window.desktopRemoteFixture.holdRunStatus = true; window.desktopRemoteFixture.runState = "settled"')
    await wait('typeof window.releaseRunStatus === "function"', 'terminal read pending')
    await click('.sb-navitem', '分析')
    await read('window.desktopRemoteFixture.holdRunStatus = false; window.releaseRunStatus()')
    await wait('window.desktopRemoteFixture.intent === null', 'terminal receipt retired after navigation')
    await click('[data-remote-session="native-session"]')
    await wait('window.desktopRemoteFixture.submitInputs.length === 3', 'queue reconciles terminal evidence after view cancellation')
    return { remoteSessionParity: { metaPromptRouting: true, hostSlashKeyboardSelection: true, pinUnpin: true, rename: true, archiveRestore: true, queueTerminalGate: true, queueSurvivesMetaPrompts: true, adoptedSessionNavigation: true, backgroundReconnectPaused: true, cancelledTerminalReadReconciled: true, noLocalExecution: true } }
  }
  await click('button[aria-label="右侧工作区"]')
  const remotePanel = '#remote-right-surface-pane'
  await wait(`document.querySelector('${remotePanel} [role=tab][aria-selected=true]')?.textContent.includes('纵览')`, 'remote uses normal overview tab')
  const addSurface = async (label) => {
    await click(remotePanel + ' button[aria-label="添加 Surface"]')
    await click(remotePanel + ' [role=menuitem]', label)
  }
  await addSurface('文件')
  await wait(`document.querySelector('${remotePanel} [data-workspace-path="README.md"]') != null`, 'remote shared file tree loaded')
  check(!(await read('document.querySelector(".remote-files-drawer")')), 'Remote still uses its separate overlay drawer')
  check(await read(`(() => { const chat = document.querySelector('.main-area').getBoundingClientRect(); const panel = document.querySelector('${remotePanel}').getBoundingClientRect(); return panel.width > 0 && chat.right <= panel.left })()`), 'Remote panel overlaps the conversation instead of sharing normal columns')
  check(!(await read(`document.querySelector('${remotePanel} button[title="新建文件"]')`)), 'Remote read-only tree exposes local file creation')
  await click(remotePanel + ' [data-workspace-path="src"]')
  await wait(`document.querySelector('${remotePanel} [data-workspace-path="src/nested.txt"]') != null`, 'nested remote tree expansion')
  await click(remotePanel + ' .workspace-load-more')
  await wait(`document.querySelector('${remotePanel} [data-workspace-path="image.png"]') != null`, 'remote directory cursor pagination')
  await click(remotePanel + ' [data-workspace-path="README.md"]')
  await wait(`document.querySelector('${remotePanel} textarea')?.value === 'first remote page'`, 'remote file preview')
  check(await read(`document.querySelector('${remotePanel} textarea').readOnly`), 'Remote file editor is writable')
  await click(remotePanel + ' .workspace-editorbar button', '下一页')
  await wait(`document.querySelector('${remotePanel} textarea')?.value === 'second remote page'`, 'remote snapshot file pagination')
  check((await fixture()).fileReads.at(-1).snapshot === 'remote-snapshot', 'Remote file pagination lost its revision snapshot')
  await capture('remote-shared-workbench')
  await click(remotePanel + ' button[title="返回文件树"]')
  await click(remotePanel + ' [data-workspace-path="image.png"]')
  await wait(`document.querySelector('${remotePanel} [role=alert]')?.textContent.includes('SCRY_FILE_PREVIEW_UNSUPPORTED')`, 'unsupported remote preview stays remote')
  await click(remotePanel + ' button[title="返回文件树"]')
  await click(remotePanel + ' [data-workspace-path="small.md"]')
  await wait(`document.querySelector('${remotePanel} .workspace-preview h1')?.textContent === 'Remote markdown'`, 'remote small Markdown uses the shared preview')
  await click(remotePanel + ' .workspace-editorbar button', '展开源码')
  await wait(`document.querySelector('${remotePanel} textarea')?.readOnly === true && !document.querySelector('${remotePanel} .workspace-editorbar .primary')`, 'remote Markdown source is read-only and has no local save action')
  await click(remotePanel + ' button[title="返回文件树"]')
  await click(remotePanel + ' [data-workspace-path="README.md"]')
  await wait(`document.querySelector('${remotePanel} textarea')?.value === 'first remote page'`, 'remote file reopened')
  const widthBefore = await read('document.querySelector(\'[aria-controls="remote-right-surface-pane"][role=separator]\').getAttribute("aria-valuenow")')
  const splitterPoint = await pointFor('[aria-controls="remote-right-surface-pane"][role=separator]')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...splitterPoint, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: splitterPoint.x - 30, y: splitterPoint.y, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: splitterPoint.x - 30, y: splitterPoint.y, button: 'left', clickCount: 1 })
  await wait(`document.querySelector('[aria-controls="remote-right-surface-pane"][role=separator]').getAttribute('aria-valuenow') !== ${JSON.stringify(widthBefore)}`, 'remote uses normal pointer panel resizing')
  await addSurface('终端')
  await wait(`document.querySelector('${remotePanel} .surface-unavailable')?.textContent.includes('需要更新远端 Scry')`, 'older host requires a real protocol upgrade')
  await click(remotePanel + ' button[aria-label="关闭 终端"]')
  await wait(`document.querySelector('${remotePanel} [role=tab][aria-selected=true]')?.textContent.includes('文件')`, 'closing remote tab selects its neighbour')
  await click(remotePanel + ' button[aria-label="最大化右侧工作区"]')
  await wait('document.querySelector(".app").classList.contains("right-panel-maximized")', 'remote panel maximizes in normal shell')
  await click(remotePanel + ' button[aria-label="恢复右侧工作区"]')
  await wait('!document.querySelector(".app").classList.contains("right-panel-maximized")', 'remote panel restores')
  await click('[data-remote-session="other-native"]')
  await wait('document.querySelector(".app").classList.contains("right-panel-hidden")', 'other remote session has independent panel visibility')
  await click('[data-remote-session="old-native"]')
  await wait(`document.querySelector('${remotePanel} [role=tab][aria-selected=true]')?.textContent.includes('文件') && !document.querySelector('.app').classList.contains('right-panel-hidden')`, 'remote session restores its own tabs')
  check((await fixture()).fileLists.every(call => call.id === 'fixture-connection' && call.context.cwd === '/fixture/project-a'), 'Remote tree read escaped its host/workspace')
  check((await fixture()).localWorkspaceCalls.length === 0, 'Remote workbench called a local workspace API')
  await click('.sb-new')
  await click('.location-button')
  await click('[data-machine-id="local"]')
  await click('.location-projects .mitem', '不绑定项目')
  await wait('document.querySelector(".execution-location.is-remote") == null', 'returned to local composer')
  const localBefore = (await fixture()).localNewSessions
  const historyBeforeNewDraft = (await fixture()).historyCalls.length
  await click('textarea[aria-label="描述任务"]')
  await insert('carried draft')
  await click('.location-button')
  await wait('document.querySelector(\'[data-machine-id="fixture-connection"]\') != null', 'location menu machines')
  const pickerGeometry = () => read(`(() => {
    const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height } }
    return [document.querySelector('.location-menu'), ...document.querySelectorAll('.location-machine')].map(rect)
  })()`)
  const hoverMachine = async (id) => {
    const selector = '[data-machine-id="' + id + '"]'
    const point = await pointFor(selector)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await wait('document.querySelector(' + JSON.stringify(selector) + ').classList.contains("is-shown")', 'hovered machine projects')
    return point
  }
  const checkPickerHover = async () => {
    await read('Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime < Infinity).map(animation => animation.finished))')
    await hoverMachine('local')
    const before = await pickerGeometry()
    for (const id of ['fixture-connection', 'local', 'fixture-connection', 'local']) {
      const point = await hoverMachine(id)
      const after = await pickerGeometry()
      check(after.every((rect, index) => Object.keys(rect).every(key => Math.abs(rect[key] - before[index][key]) < 0.5)), 'Hover moved the execution menu or machine rows: ' + JSON.stringify({ before, after }))
      check(await read('document.elementFromPoint(' + point.x + ',' + point.y + ').closest("[data-machine-id]")?.dataset.machineId === ' + JSON.stringify(id)), 'Stationary pointer no longer hits the hovered machine')
      check(await read('document.querySelector(\'[data-machine-id="local"]\').getAttribute("aria-checked") === "true"'), 'Hover changed the selected execution machine')
    }
    check((await fixture()).localNewSessions === localBefore && (await fixture()).submitInputs.length === 0, 'Hover started a session or submitted a draft')
  }
  await checkPickerHover()
  await capture('location-hover-local')
  await hoverMachine('fixture-connection')
  await capture('location-hover-remote')
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 600, deviceScaleFactor: 1, mobile: false })
  await checkPickerHover()
  check(await read('document.querySelector(".location-menu").getBoundingClientRect().top >= 0'), 'Short-window picker is clipped above the viewport')
  await capture('location-hover-short-window')
  await send('Emulation.clearDeviceMetricsOverride')
  await click('[data-machine-id="fixture-connection"]')
  await read('window.desktopRemoteFixture.oldDirectoryHost = true; window.refreshFixtureCatalog()')
  await wait('document.querySelector(".location-custom-directory")?.disabled', 'old host capability is unavailable')
  check((await fixture()).directoryReads.length === 0, 'Old host was probed for unsupported directories')
  await read('window.desktopRemoteFixture.oldDirectoryHost = false; window.refreshFixtureCatalog()')
  await wait('document.querySelector(".location-custom-directory")?.disabled === false', 'new host directory selection capability')
  await click('.location-custom-directory')
  await wait('document.querySelector("input[name=remotePath]")?.value === "/fixture/home" && document.querySelector(".remote-directory-body")?.getAttribute("aria-busy") === "false"', 'host home directory loaded')
  check((await fixture()).directoryGrants.length === 0, 'Browsing authorized a project')
  const directoryModalInViewport = () => read('(() => { const modal = document.querySelector(".remote-directory-modal"); const r = modal.getBoundingClientRect(); return modal.parentElement.parentElement === document.body && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth })()')
  check(await directoryModalInViewport(), 'Remote directory modal is clipped by the composer containing block')
  await capture('remote-directory-browse')
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 600, deviceScaleFactor: 1, mobile: false })
  check(await directoryModalInViewport(), 'Remote directory modal is outside the short-window viewport')
  await capture('remote-directory-short-window')
  await send('Emulation.clearDeviceMetricsOverride')
  await key('Escape')
  await wait('!document.querySelector(".remote-directory-modal") && document.activeElement?.classList.contains("location-button")', 'directory cancel restores composer context focus')
  check((await fixture()).directorySelectCalls.length === 0 && await read(composerValue) === 'carried draft', 'Cancel changed a draft or granted a directory')
  await click('.location-button'); await click('[data-machine-id="fixture-connection"]'); await click('.location-custom-directory')
  await wait('document.querySelector("input[name=remotePath]")?.value === "/fixture/home" && document.querySelector(".remote-directory-body")?.getAttribute("aria-busy") === "false"', 'directory browser reopened')
  await click('input[name=remotePath]'); await read('document.querySelector("input[name=remotePath]").select()'); await insert('/missing-directory'); await formEnter()
  await wait('document.querySelector(".remote-directory-body [role=alert]")?.textContent.includes("directory_unavailable")', 'invalid remote path error')
  check(await read('document.querySelector(".remote-directory-actions .is-primary").disabled'), 'Failed path was selectable')
  await click('.remote-directory-navigation button:first-child')
  await wait('document.querySelector("input[name=remotePath]")?.value === "/fixture/home" && document.querySelector(".remote-directory-body")?.getAttribute("aria-busy") === "false"', 'return to host home')
  await click('.remote-directory-list > button.hosts-button')
  await wait('document.querySelectorAll(".remote-directory-entry").length === 3', 'paged directory list')
  await click('[data-remote-directory="/fixture/home/custom"]')
  await wait('document.querySelector("input[name=remotePath]")?.value === "/fixture/home/custom" && document.querySelector(".remote-directory-body")?.getAttribute("aria-busy") === "false"', 'custom remote directory browsed')
  check((await fixture()).directorySelectCalls.length === 0, 'Entering a directory granted it')
  await read('window.desktopRemoteFixture.connected = false; window.refreshFixtureConnections()')
  await wait('document.querySelector(".remote-directory-actions .is-primary").disabled', 'offline directory selection blocked')
  await read('window.desktopRemoteFixture.connected = true; window.refreshFixtureConnections()')
  await wait('!document.querySelector(".remote-directory-actions .is-primary").disabled', 'directory selection explicitly available after reconnect')
  await read('window.desktopRemoteFixture.selectDirectoryFailure = true')
  await click('.remote-directory-actions .is-primary')
  await wait('document.querySelector(".remote-directory-body [role=alert]")?.textContent.includes("未能确认")', 'grant result failure stays visible')
  check((await fixture()).directoryGrants.length === 0 && (await fixture()).localStarts === 0, 'Unconfirmed selection granted or executed a project')
  await read('window.desktopRemoteFixture.selectDirectoryFailure = false; window.desktopRemoteFixture.holdDirectorySelection = true')
  await click('.remote-directory-actions .is-primary')
  await wait('typeof window.releaseDirectorySelection === "function"', 'directory selection pending')
  await click('.remote-directory-actions .is-primary'); await key('Escape')
  check((await fixture()).directorySelectCalls.length === 2 && await read('!!document.querySelector(".remote-directory-modal")'), 'Pending selection was duplicated or dismissed')
  await capture('remote-custom-directory')
  await read('window.releaseDirectorySelection()')
  await wait('!document.querySelector(".remote-directory-modal") && document.querySelector(".execution-location.is-remote") != null', 'custom selection changes only draft execution location')
  check((await fixture()).directoryGrants.length === 1 && (await fixture()).submitInputs.length === 0 && (await fixture()).localStarts === 0, 'Custom directory selection implicitly submitted or fell back locally')
  check(await read(composerValue) === 'carried draft', 'Custom selection lost the draft')
  await click('.location-button'); await click('[data-machine-id="fixture-connection"]')
  await wait('document.querySelector(\'[data-remote-project="/fixture/project-a"]\') != null', 'remote projects for selected machine')
  await click('[data-remote-project="/fixture/project-a"]')
  await wait(remoteShown, 'remote location opens the shared conversation')
  check(await read('document.querySelector(".execution-location.is-remote").textContent === "Fixture desktop"'), 'Topbar did not name the remote machine')
  check(await read(`${composerValue} === "carried draft"`), 'Location switch dropped the unsent draft')
  check((await fixture()).localNewSessions === localBefore, 'Remote location called local newSession')
  check((await fixture()).historyCalls.length === historyBeforeNewDraft, 'New remote draft queried history before a session existed')

  await wait('document.querySelector(".permission-mode-trigger .rc-value")?.textContent === "Default · Fixture desktop"', 'host-named default permission')
  await click('.permission-mode-trigger')
  await wait('document.querySelector(".permission-mode-option.is-danger") != null', 'permission options')
  check(await read('document.querySelector(".permission-mode-option.is-danger").textContent.includes("Full access · Fixture desktop")'), 'Full access copy does not name the executing host')
  await click('.permission-mode-option.is-danger')
  await wait('document.querySelector(".permission-mode-trigger .rc-value")?.textContent === "Full access · Fixture desktop"', 'full_access permission selection')
  await click('textarea[aria-label="描述任务"]')
  await pasteImage()
  await wait('document.querySelector(".draft-attachments img")?.naturalWidth === 2', 'remote pasted image decoded preview')
  await read(`(() => { const node = document.querySelector('textarea[aria-label="描述任务"]'); node.select() })()`)
  await insert('first prompt')
  await read('window.desktopRemoteFixture.holdSubmit = true')
  await key('Enter')
  await key('Enter')
  await wait('window.desktopRemoteFixture.submitInputs.length === 1', 'double Enter submit')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("正在提交到远端")', 'submission without an acknowledgement')
  check(!(await read('document.querySelector(".composer-notice")?.textContent.includes("已记录提交")')), 'Unacknowledged submission claimed a recorded receipt')
  await read('window.desktopRemoteFixture.holdSubmit = false; window.releaseSubmit()')
  const afterFirstSubmit = await fixture()
  check(afterFirstSubmit.submitInputs.length === 1, 'Double Enter submitted more than once')
  check(afterFirstSubmit.submitInputs[0].prompt === 'first prompt', 'Remote submit did not send the composer text')
  check(afterFirstSubmit.submitInputs[0].context.cwd === '/fixture/project-a', 'First submit used the wrong remote project: ' + afterFirstSubmit.submitInputs[0].context.cwd)
  check(afterFirstSubmit.submitInputs[0].permissionMode === 'full_access', 'Selected permission was not submitted')
  check(afterFirstSubmit.submitInputs[0].attachments?.[0]?.name === 'pasted.png', 'Remote submit lost pasted image attachment')
  check(afterFirstSubmit.submitInputs[0].context.externalSessionId === undefined, 'First message unexpectedly had a native session')
  await wait('window.desktopRemoteFixture.traceCalls.some(call => call.runId === "remote-run-fixture-1")', 'canonical trace lookup')
  await wait('document.querySelector(".question-inline-form") != null', 'remote question')
  check(!(await read('document.querySelector(".composer-notice")?.textContent.includes("等待远端派发")')), 'Adopted dispatched run still shows waiting for dispatch')
  check(await read('document.querySelector(".clibtn").disabled'), 'Adopted session must keep its Provider identity')

  await click('.run-status-stop')
  await wait('window.desktopRemoteFixture.stopCalls.length === 1', 'remote stop')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("已请求停止，等待远端确认")', 'stop acknowledgement remains visible on a dispatched run')
  check((await fixture()).stopCalls[0] === '11111111-1111-4111-8111-111111111111', 'Stop did not use the ledger intent UUID')
  const historyBeforeTerminal = (await fixture()).historyCalls.length
  // The label is the native option hit area, including its radio. Pinning a
  // short transcript can shift the 16px input within that same clickable label.
  await click('.question-option')
  check(await read('document.querySelector(\'.question-option input[type="radio"]\').checked'), 'Native option click did not select the radio')
  await click('.question-submit')
  await wait('document.querySelector(".question-error")?.textContent.includes("remote answer rejected")', 'stable answer failure')
  const afterAnswer = await fixture()
  check(afterAnswer.answerCalls.length === 1 && afterAnswer.answerCalls[0].runId === '11111111-1111-4111-8111-111111111111', 'Answer did not use the ledger intent UUID')
  check(!(await bodyText()).includes('已发送回答'), 'Failed answer was rendered as success')
  await wait('window.desktopRemoteFixture.firstIntentCleared === true', 'clear first intent')
  await wait(`window.desktopRemoteFixture.historyCalls.length > ${historyBeforeTerminal}`, 'terminal status refreshes canonical history')
  check(await read('document.querySelector(".composer-notice")?.textContent.includes("remote answer rejected")'), 'Successful poll erased an unrelated action error')

  await wait('document.querySelector(".run-status") == null', 'first run no longer blocks the composer')
  await wait('document.body.textContent.includes("archived terminal turn")', 'terminal history survives a failed final trace read')
  await click('textarea[aria-label="描述任务"]')
  await insert('next prompt after native adoption')
  await read('window.desktopRemoteFixture.runState = "recorded"; window.desktopRemoteFixture.exposeTrace = false')
  await key('Enter')
  await wait('window.desktopRemoteFixture.submitInputs.length === 2', 'next message')
  check((await fixture()).submitInputs[1].context.externalSessionId === 'native-session', 'New native session was not adopted for the next message')
  check((await fixture()).submitInputs[1].context.cwd === '/fixture/project-a', 'Resumed submit used the wrong remote project')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("等待远端派发")', 'recorded receipt waits for dispatch on the next turn')
  await read('window.desktopRemoteFixture.runStatusFailure = true')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("desktop_remote_output_capture_queue_full")', 'poll failure remains visible while unconfirmed')
  await read('window.desktopRemoteFixture.runStatusFailure = false; window.desktopRemoteFixture.runState = "unknown"')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("远程运行结果未知")', 'unknown run state is not hidden as dispatched')
  await read('window.desktopRemoteFixture.runState = "dispatched"')
  await wait('document.querySelector(".composer-notice") == null', 'dispatch retires waiting notice before trace arrives')
  check(await read('document.querySelector(".run-status") != null'), 'Dispatched run no longer blocks the composer')
  check(!(await fixture()).traceCalls.some(call => call.runId === 'remote-run-fixture-2'), 'Dispatch notice check unexpectedly relied on trace output')
  await read('window.desktopRemoteFixture.exposeTrace = true')
  await wait('window.desktopRemoteFixture.traceCalls.some(call => call.runId === "remote-run-fixture-2")', 'second remote run trace')
  await wait('document.body.textContent.includes("second remote run")', 'second remote run displayed')
  check(!(await read('document.querySelector(".composer-notice")?.textContent.includes("等待远端派发")')), 'Dispatched remote run still shows waiting for dispatch')
  check((await bodyText()).includes('remote background task'), 'Remote background task panel was not visible')
  check(!(await read('document.querySelector("[aria-label^=\\"停止任务\\"]")')), 'Remote background task exposed a task-stop control')
  check((await fixture()).backgroundStopCalls === 0, 'Remote background task reached stopBackgroundTask while visible')
  check(!(await read('document.querySelector(".location-button")')), 'Existing remote session exposed the location picker')

  // New conversation stays on the current machine and project.
  const beforeNewProject = await read('document.querySelector(".execution-location.is-remote").closest(".tb-thread").getAttribute("title")')
  check(beforeNewProject === '/fixture/project-a', 'Remote project changed before New conversation: ' + beforeNewProject)
  await click('.sb-new')
  // Controls reset in an effect after remount; wait for the settled default so coordinates stay valid.
  await wait('!document.querySelector(".clibtn").disabled && !document.body.textContent.includes("second remote run") && document.querySelector(".model-effort-model")?.textContent === "Alpha Default"', 'new draft on same machine unlocks execution context')
  check(await read(remoteShown), 'New conversation left the remote machine')
  const newConversationLocation = await read('document.querySelector(".location-button").getAttribute("aria-label")')
  check(newConversationLocation === '执行位置：Fixture desktop / /fixture/project-a', 'New conversation changed the project: ' + newConversationLocation)
  // Opening on a remote draft must focus the checked machine, not the first
  // enabled (local) machine and silently replace the project's column.
  await click('.location-button')
  await wait('document.querySelector(".location-menu") != null', 'remote draft picker reopened')
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  check(await read('document.activeElement?.getAttribute("data-machine-id") === "fixture-connection"'), 'Remote picker initial focus moved to local machine')
  check(await read('document.querySelector(".location-custom-directory") != null'), 'Remote picker initial focus replaced remote projects with local folders')
  await key('Escape')
  const afterNew = await fixture()
  check(afterNew.localNewSessions === localBefore, 'Remote new conversation called local newSession')
  check(afterNew.stopCalls.length === 1, 'Context switch stopped the previous remote run')
  check(afterNew.backgroundStopCalls === 0, 'Remote background task reached stopBackgroundTask after context switch')

  await click('.clibtn')
  await wait('document.querySelector(\'.climenu [data-agent-id="qoder"]\') != null', 'remote Provider menu')
  check(!(await bodyText()).includes('添加 Pi Agent'), 'Remote Provider menu offered local Pi management')
  await click('.climenu [data-agent-id="qoder"]')
  await wait('document.querySelector(".model-effort-model")?.textContent === "Beta Default" && document.querySelector(".permission-mode-trigger .rc-value")?.textContent === "Default · Fixture desktop"', 'provider control reset')
  await wait(`window.desktopRemoteFixture.intentsCalls > ${afterNew.intentsCalls}`, 'next-context poll')
  check(!(await bodyText()).includes('second remote run'), 'A later poll restored the old transcript')
  await click('.clibtn')
  await wait('document.querySelector(\'.climenu [data-agent-id="claude:alternate"]\') != null', 'alternate profile option')
  await click('.climenu [data-agent-id="claude:alternate"]')
  await wait('document.querySelector(".model-effort-model")?.textContent === "Alternate model"', 'same-provider alternate profile')
  await click('textarea[aria-label="描述任务"]')
  await insert('alternate profile prompt')
  await key('Enter')
  await wait('window.desktopRemoteFixture.submitInputs.length === 3', 'alternate profile submit')
  const finalState = await fixture()
  check(finalState.submitInputs[2].context.providerId === 'claude' && finalState.submitInputs[2].context.agentProfileId === 'alternate', 'Same-provider profile selection routed to the wrong runtime')

  // Transport state changes are fixture events, not programmatic UI clicks.
  await read('window.desktopRemoteFixture.connected = false; window.desktopRemoteFixture.intent = null')
  await wait('document.querySelector(".execution-location.is-remote")?.dataset.state === "disconnected"', 'SSH exit reflected in topbar')
  await wait('document.querySelector(".composer-notice")?.textContent.includes("Fixture desktop 未连接")', 'offline notice without a draft')
  await click('textarea[aria-label="描述任务"]'); await insert('unsent offline draft'); await key('Enter')
  check((await fixture()).submitInputs.length === 3 && (await fixture()).localStarts === 0, 'Offline remote draft reached a Provider')
  check(await read(sendDisabled), 'Offline remote send is enabled')
  await read('window.desktopRemoteFixture.listFailure = true')
  await wait('document.querySelector(".execution-location.is-remote")?.dataset.state === "unknown"', 'read failure is not an empty or connected list')
  check(await read('document.querySelector(".composer-notice").textContent.includes("无法确认 Fixture desktop 的连接状态")'), 'Read failure was not explained')
  check(await read('document.querySelector(".sb-remote-proj")?.textContent.includes("Fixture desktop")'), 'Read failure forgot saved host')
  check(!(await read('document.querySelector(".sb-hosts")')), 'Legacy hosts navigation returned after failed read')
  await read('window.desktopRemoteFixture.listFailure = false')
  await wait('document.querySelector(".execution-location.is-remote")?.dataset.state === "disconnected"', 'read recovery')
  await click('.composer-notice button')
  await wait(`!${sendDisabled}`, 'explicit reconnect')
  check(await read(`${composerValue} === "unsent offline draft"`), 'Reconnect discarded the draft')
  check((await fixture()).submitInputs.length === 3, 'Reconnect automatically resubmitted a draft')
  check(!(await read('document.querySelector(".composer-notice")?.textContent.includes("等待远端派发")')), 'Dispatch notice outlived the finished remote intent')
  check(await read('(() => { const name = document.querySelector(".sb-remote-proj .pname"); return name.scrollWidth <= name.clientWidth })()'), 'Remote project name truncated before the host tag')

  await capture('remote-workspace')
  await read('window.desktopRemoteFixture.connected = false; window.desktopRemoteFixture.hideProvider = true')
  await wait('document.querySelector(".composer-notice:not(.is-info) button") != null', 'offline before Provider removal')
  await click('.composer-notice button')
  await wait('document.querySelector(".clibtn")?.textContent.includes("原 Provider")', 'missing Provider is not replaced')
  check(await read(sendDisabled), 'Missing Provider allowed submission')
  await read('window.desktopRemoteFixture.connected = false; window.desktopRemoteFixture.hideProvider = false')
  await wait('document.querySelector(".composer-notice:not(.is-info) button") != null', 'offline before Provider restore')
  await click('.composer-notice button')
  await wait(`!${sendDisabled}`, 'original Provider restored')

  // Back to this Mac: a new draft picks the local machine; local new sessions stay intact.
  await click('.sb-new')
  // The old session also has a location button. Wait for the new draft before
  // measuring it, or the transition can move the target before native input.
  await wait('document.querySelector(".unbound-empty.bound") != null && document.querySelector(".location-button") != null', 'remote new draft location picker')
  await click('.location-button')
  await wait('document.querySelector(\'[data-machine-id="local"]\') != null', 'local machine option')
  await click('[data-machine-id="local"]')
  await wait('[...document.querySelectorAll(".location-menu .mitem")].some(node => node.textContent.includes("不绑定项目"))', 'local projects column')
  await read('[...document.querySelectorAll(".location-menu .mitem")].find(node => node.textContent.includes("不绑定项目")).setAttribute("data-local-unbound", "")')
  await click('[data-local-unbound]')
  await wait(`!(${remoteShown})`, 'local location leaves the remote conversation')
  await click('.sb-new')
  await wait(`window.desktopRemoteFixture.localNewSessions === ${localBefore + 1}`, 'local new-session route remains intact')
  check(!(await read(remoteShown)), 'Local new session retained the remote composer')
  check((await fixture()).localStarts === 0, 'New-session selection started an unrequested local model')

  await click('.sb-settings')
  await click('.settings-rail button:last-child')
  await wait('document.querySelector(".remote-pairing")?.textContent.includes("Fixture iPhone")', 'inbound device grant')
  check(await read('document.querySelector(".remote-connections-settings").textContent.includes("Fixture desktop")'), 'Remote settings omitted saved host')
  check(!(await read('document.querySelector(".remote-connections-settings").textContent.includes("Fixture iPhone")')), 'Inbound grants mixed into outbound hosts')
  check(!(await read('document.querySelector(".hosts-view") || document.querySelector(".remote-client-settings") || document.querySelector(".sb-hosts")')), 'Legacy hosts page or jump remains')
  check(await read('document.querySelector(".remote-access-inbound").textContent.includes("Fixture iPhone")'), 'Settings omitted inbound grant')
  check(!(await read('document.querySelector(".remote-access-card-note")')), 'Default remote cards contain explanatory small copy')
  await capture('remote-settings')
  await click('.hosts-row-toggle')
  await wait('document.querySelectorAll(".hosts-projects li").length === 3', 'host projects listed')
  await capture('remote-hosts')

  // Editing changes routing only. Cancel, validation, storage failure and double-submit use real DOM input.
  await click('.hosts-address-summary button')
  await wait('document.activeElement?.name === "hostname"', 'address editor initial focus')
  check(await read('document.querySelector(\'input[name="hostname"]\').value === "fixture.invalid" && document.querySelector(\'input[name="username"]\').value === "fixture" && document.querySelector(\'input[name="port"]\').value === "22"'), 'Address editor did not prefill the saved target')
  check(await read('document.querySelector(\'.hosts-address-actions button[type="submit"]\').disabled'), 'Unchanged address was saveable')
  await read('document.querySelector(\'input[name="hostname"]\').select()'); await insert('cancelled.invalid')
  await key('Escape')
  await wait('!document.querySelector(".hosts-address-form")', 'cancel address editing')
  check((await fixture()).updateSshCalls.length === 0, 'Cancel wrote an address')
  check(await read('document.querySelector(".hosts-address-summary button") === document.activeElement'), 'Cancel did not restore focus')
  await click('.hosts-address-summary button')
  await wait('document.activeElement?.name === "hostname"', 'reopen address editor')
  check(await read('document.querySelector(\'input[name="hostname"]\').value === "fixture.invalid"'), 'Cancelled address leaked into saved fields')
  await read('document.querySelector(\'input[name="hostname"]\').select()'); await insert('30.7.226.226')
  await click('input[name="port"]'); await read('document.querySelector(\'input[name="port"]\').select()'); await insert('0'); await formEnter()
  check(await read('document.querySelector(\'input[name="port"]\').validity.rangeUnderflow'), 'Invalid port was not rejected by the form')
  check((await fixture()).updateSshCalls.length === 0, 'Invalid port reached IPC')
  await read('document.querySelector(\'input[name="port"]\').select()'); await insert('2222')
  await read('window.desktopRemoteFixture.updateFailure = true')
  await formEnter()
  await wait('document.querySelector(".hosts-address-form [role=alert]")?.textContent.includes("fixture secure storage failure")', 'save failure stays visible')
  check(await read('document.querySelector(".hosts-row-head code").textContent === "fixture@fixture.invalid:22"'), 'Failed save changed the saved address')
  await capture('host-address-editor')
  const connectsBeforeEdit = (await fixture()).connectCalls
  await read('window.desktopRemoteFixture.updateFailure = false; window.desktopRemoteFixture.holdAddressUpdate = true')
  await formEnter(); await formEnter()
  await wait('document.querySelector(".hosts-address-form")?.getAttribute("aria-busy") === "true"', 'address save in flight')
  check((await fixture()).updateSshCalls.length === 2, 'Double Enter duplicated address save')
  check(await read('[...document.querySelectorAll(".hosts-address-form input")].every(node => node.readOnly) && [...document.querySelectorAll(".hosts-address-form button")].every(node => node.disabled)'), 'In-flight address editor allowed edits or another action')
  check(await read('document.querySelector(".hosts-address-form").contains(document.activeElement)'), 'Address save lost keyboard focus')
  await read('window.releaseAddressUpdate()')
  await wait('!document.querySelector(".hosts-address-form") && document.querySelector(".hosts-row-head code")?.textContent === "fixture@30.7.226.226:2222"', 'new target saved')
  const afterEdit = await fixture()
  check(afterEdit.updateSshCalls[1].id === 'fixture-connection', 'Address edit changed connection identity')
  check(afterEdit.connectCalls === connectsBeforeEdit && !afterEdit.connected, 'Address edit automatically reconnected')
  check(afterEdit.submitInputs.length === 3 && afterEdit.localStarts === 0, 'Address edit started a Provider')
  check(await read('document.querySelector(".hosts-row-details").textContent.includes("fixture-fingerprint")'), 'Address edit replaced the pinned identity')
  check(await read('[...document.querySelectorAll(".hosts-projects button")].every(node => node.disabled)'), 'Disconnected projects allowed session creation')
  await click('.hosts-row-actions button')
  await wait('window.desktopRemoteFixture.connected && document.querySelector(".hosts-state")?.getAttribute("data-state") === "connected"', 'explicit reconnect after editing')
  await read('[...document.querySelectorAll(".hosts-projects li")].find(node => node.querySelector("code")?.textContent === "/fixture/project-b").querySelector("button").setAttribute("data-host-project-b", "")')
  await click('[data-host-project-b]')
  await wait(`${remoteShown} && document.querySelector(".location-button")?.getAttribute("aria-label") === "执行位置：Fixture desktop / /fixture/project-b"`, 'host project opens a remote draft')

  await new Promise(resolve => { contents.once('did-finish-load', resolve); contents.reload() })
  await wait('document.querySelector("[data-app-fixture]") != null', 'fixture reload')
  await click('[data-app-fixture]')
  await wait('document.querySelector(\'[data-remote-session="old-native"]\') != null', 'saved host sessions after renderer reload')
  const historyBefore = (await fixture()).historyCalls.length
  await click('[data-remote-session="old-native"]')
  await wait(`window.desktopRemoteFixture.historyCalls.length > ${historyBefore}`, 'sidebar remote session loads history')
  check((await fixture()).historyCalls.at(-1).externalSessionId === 'old-native', 'Sidebar session loaded the wrong history')
  await wait('document.querySelector(".clibtn")?.disabled === true', 'bound session context')
  check(!(await read('document.querySelector(".location-button")')), 'Bound session exposed the location picker')
  await read('window.desktopRemoteFixture.connected = false; window.desktopRemoteFixture.catalogRevision = 1')
  await wait('document.querySelector(".composer-notice:not(.is-info) button") != null', 'bound session disconnect')
  await click('.composer-notice button')
  await wait('document.querySelector(".sb-remote-proj .pname")?.textContent === "Project A v2"', 'reconnect refreshes catalog alongside bound-session history')

  return {
    remoteDirectoryPicker: { oldHostUnavailable: true, cancelFocusAndDraft: true, browseDoesNotGrant: true, invalidPath: true, pagination: true, offlineBlocked: true, uncertainGrantVisible: true, explicitSelectionOnly: true, noImplicitSend: true },
    locationHoverStable: { menu: true, machineRows: true, stationaryPointer: true, shortWindow: true, noImplicitSelection: true },
    hostAddressEdit: { cancel: true, focusRestored: true, validation: true, storageFailure: true, doubleEnterSingleSave: true, identityKept: true, explicitReconnect: true, noProviderStart: true },
    boundSessionReconnectRefreshesCatalog: true,
    savedHostsAfterRendererReload: true,
    remoteSettingsSeparateConnectionDirections: true,
    remoteSettingsDirectEntryKeepsDraft: true,
    removedProviderNeverSubstituted: true,
    sharedChatViewForRemote: true,
    remoteSessionParity: { metaPromptRouting: true, hostSlashKeyboardSelection: true, pinUnpin: true, rename: true, archiveRestore: true },
    locationPickerCarriesDraft: true,
    hostNamedPermissionCopy: true,
    existingSessionIdentityLocked: true,
    offlineNeverFallsBack: true,
    readFailureKeepsSavedHosts: true,
    reconnectPreservesDraft: true,
    staleDispatchNoticeCleared: true,
    dispatchNoticeLifecycle: { unacknowledged: true, recorded: true, unknown: true, dispatchedBeforeTrace: true, resumedTurn: true, stopAcknowledgement: true, pollErrorRecovery: true, terminalHistoryRefresh: true, actionErrorPreserved: true },
    remoteWorkbench: { sharedTabsAndColumns: true, resize: true, maximizeRestore: true, sessionScopedTabs: true, treePagination: true, snapshotFilePagination: true, markdownPreview: true, unsupportedPreviewNeverLocal: true, unavailableTerminal: true },
    remoteSidebarActivity: { activityTab: true, activitySelection: true, failedCatalogRemoved: true, idleNotCompleted: true, backgroundStartStop: true, sharedSpinner: true, recentProjectOrder: true, localPinsPreserved: true, staleReadNotLive: true, collapseSurvivesSearch: true },
    hostEnableInviteDisable: true,
    providerProfileIdentity: true,
    nativeCoordinateInput: true,
    newSessionHistoryGuard: true,
    doubleEnterSingleSubmit: true,
    canonicalScryRunTrace: true,
    ledgerUuidStopAndAnswer: true,
    failedAnswerNotSuccess: true,
    nativeSessionAdoption: true,
    providerControlReset: true,
    fullAccessSelection: true,
    contextSwitchIsolation: true,
    remoteBackgroundCannotStopLocal: true,
    calls: { history: finalState.historyCalls.length, traces: finalState.traceCalls.length, submits: finalState.submitInputs.length, stops: finalState.stopCalls.length, answers: finalState.answerCalls.length }
  }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name), { recursive: true })))
  await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir')
  await writeFile(join(temp, 'fixture.tsx'), fixtureSource)
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    // Mutation control stays in this fixture's bundle; production files are untouched.
    plugins: negativeControl || negativeMachineControl || negativeAddressControl || negativeHoverControl || negativeActivityControl || negativeWorkspaceControl || negativePromptControl || negativeSettingsControl || negativeSlashControl || negativeHistorySlashControl || negativeProviderRevisionControl ? [{ name: 'remote-negative-control', enforce: 'pre', transform(source, id) {
      if (negativeProviderRevisionControl && id.endsWith('/RemoteChat.tsx')) {
        const dependency = ', provider?.metadataRevision'
        if (!source.includes(dependency)) throw new Error('Provider metadata revision dependency not found')
        return source.replace(dependency, '')
      }
      if (negativeHistorySlashControl && id.endsWith('/ChatView.tsx')) {
        const guard = 'const slashOpen = slashRequested && !historyNavigation'
        if (!source.includes(guard)) throw new Error('history slash guard not found')
        return source.replace(guard, 'const slashOpen = slashRequested')
      }
      if (negativeSlashControl && id.endsWith('/ChatView.tsx')) {
        const heading = 'SLASH_COMMAND_COPY.heading(remoteHost, slashLoading)'
        if (!source.includes(heading)) throw new Error('slash source control not found')
        return source.replace(heading, 'SLASH_COMMAND_COPY.heading(undefined, slashLoading)')
      }
      if (negativeSettingsControl && id.endsWith('/App.tsx')) return source.replace("setSettingsTab('remote')", "setSettingsTab('appearance')")
      if (negativePromptControl && id.endsWith('/App.tsx')) {
        const target = 'const target = metaPromptTarget.current'
        if (!source.includes(target)) throw new Error('meta prompt routing control not found')
        return source.replace(target, 'const target = { view: "chat", draftKey }').replace('returnFromMetaPrompts()\n  }', 'changeView("chat")\n  }')
      }
      if (negativeWorkspaceControl && id.endsWith('/DesktopRemote.tsx')) {
        return source.replace('api.file(connectionId, context, path, offset, snapshot)', 'window.scry.workspaceReadPage({ cwd: context.cwd, path, offset, snapshot })')
      }
      if (negativeActivityControl && id.endsWith('/useRemoteCatalogs.ts')) {
        const poll = 'const timer = window.setInterval(refresh, 3000)'
        if (!source.includes(poll)) throw new Error('activity polling control not found')
        return source.replace(poll, poll + '; window.clearInterval(timer)')
      }
      if (negativeHoverControl && id.endsWith('/remote-location.css')) {
        const height = 'height: min(360px, 40vh);'
        if (!source.includes(height)) throw new Error('hover height control not found')
        return source.replace(height, 'height: auto;')
      }
      if (negativeAddressControl && id.endsWith('/HostsView.tsx')) {
        const save = 'await bridge().updateSsh(connection.id, ssh)'
        if (!source.includes(save)) throw new Error('address negative control not found')
        return source.replace(save, save + '; await bridge().connect(connection.id)')
      }
      if (negativeMachineControl && id.endsWith('/App.tsx')) {
        const route = 'onNewChat: useEventCallback(startNewConversation)'
        if (!source.includes(route)) throw new Error('machine routing negative control not found')
        return source.replace(route, 'onNewChat: useEventCallback(newConversation)')
      }
      if (!negativeControl || !id.endsWith('/ChatTurn.tsx')) return
      const guard = "work={remote ? { ...backgroundWork, taskStop: 'unavailable' } : backgroundWork}"
      if (!source.includes(guard)) throw new Error('negative control guard not found')
      return source.replace(guard, 'work={backgroundWork}')
    } }] : [],
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(temp, 'fixture.tsx'), formats: ['iife'], name: 'DesktopRemoteFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data: blob:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    const { join } = require('node:path')
    const root = ${JSON.stringify(temp)}
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', join(root, 'userData'))
    app.setPath('sessionData', join(root, 'sessionData'))
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message) })
      try {
        await win.loadFile(join(root, 'index.html'))
        win.webContents.debugger.attach('1.3')
        const result = await (${exercise.toString()})(win.webContents, ${nativeUiPointer.toString()}, async name => {
          await win.webContents.executeJavaScript('Promise.allSettled(document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime < Infinity).map(a => a.finished)).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))')
          require('node:fs').writeFileSync(join(root, name + '.png'), (await win.webContents.capturePage()).toPNG())
        }, { parityOnly: ${parityOnly}, settingsOnly: ${settingsOnly}, lifecycleOnly: ${lifecycleOnly}, openingOnly: ${openingOnly}, measureOpening: ${measureOpening}, composerHistoryOnly: ${composerHistoryOnly} })
        // Native input and capture have finished. Release their debugger/window
        // before exit instead of leaving the successful fixture alive on macOS.
        win.webContents.debugger.detach()
        win.destroy()
        process.stdout.write('SCRY_DESKTOP_REMOTE_UI_RESULT=' + JSON.stringify(result) + '\\n', () => { console.log('SCRY_DESKTOP_REMOTE_UI_EXIT_REQUEST'); app.exit(0) })
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home'), SCRY_TEST_APP: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const startedAt = performance.now()
    const lifecycle = { resultAtMs: null, exitRequestAtMs: null, exitAtMs: null, closeAtMs: null }
    let cleanupTimer
    const timer = setTimeout(() => {
      failed = true
      const failure = new Error(`DesktopRemote UI timed out (pid=${child.pid}, fixture=${temp}, lifecycle=${JSON.stringify(lifecycle)}):\\n${output.slice(-8000)}`)
      console.error(failure.message)
      cleanupTimer = stopOwnedApp(child).then(() => reject(failure), (error) => { cleanupUnknown = true; reject(new Error(`DesktopRemote cleanup unknown; fixture preserved: ${temp}`, { cause: error })) })
    // Includes three 3s background catalog transitions plus recorded/unknown/
    // dispatched run polls. Per-condition deadlines stay unchanged at 7s.
    }, 55_000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      if (lifecycle.resultAtMs === null && output.includes('SCRY_DESKTOP_REMOTE_UI_RESULT=')) lifecycle.resultAtMs = Math.round(performance.now() - startedAt)
      if (lifecycle.exitRequestAtMs === null && output.includes('SCRY_DESKTOP_REMOTE_UI_EXIT_REQUEST')) lifecycle.exitRequestAtMs = Math.round(performance.now() - startedAt)
    })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('exit', () => { lifecycle.exitAtMs = Math.round(performance.now() - startedAt) })
    child.once('error', (error) => { clearTimeout(timer); failed = true; reject(error) })
    child.once('close', (code, signal) => {
      lifecycle.closeAtMs = Math.round(performance.now() - startedAt)
      clearTimeout(timer)
      if (cleanupTimer) return
      const result = output.match(/^SCRY_DESKTOP_REMOTE_UI_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) { failed = true; reject(new Error(`DesktopRemote UI smoke failed (${code ?? signal}); fixture=${temp}:\\n${output.slice(-8000)}`)) }
      else { console.log(result); if (keepArtifacts) console.log('UI artifacts: ' + temp); resolve() }
    })
  })
} catch (error) {
  failed = true
  throw error
} finally {
  if (!cleanupUnknown && !failed && !keepArtifacts) await rm(temp, { recursive: true, force: true })
}
