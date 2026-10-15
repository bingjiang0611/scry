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
import ${JSON.stringify(join(root, 'src/renderer/codex-alignment.css'))}

const firstLedger = '11111111-1111-4111-8111-111111111111'
const secondLedger = '22222222-2222-4222-8222-222222222222'
const firstScryRun = 'remote-run-fixture-1'
const secondScryRun = 'remote-run-fixture-2'
const state = {
  historyCalls: [], traceCalls: [], submitInputs: [], stopCalls: [], answerCalls: [],
  uiEvents: [], backgroundStopCalls: 0, intentsCalls: 0, firstIntentCleared: false, answerFailure: false,
  intent: null, connected: true, hostEnabled: false, hostInviteCalls: 0, hostDisableCalls: 0,
  localNewSessions: 0, localStarts: 0, listFailure: false, hideProvider: false, catalogRevision: 0,
  updateSshCalls: [], connectCalls: 0, updateFailure: false, holdAddressUpdate: false,
  directoryReads: [], directorySelectCalls: [], directoryGrants: [], oldDirectoryHost: false, selectDirectoryFailure: false, holdDirectorySelection: false
}
const connection = {
  id: 'fixture-connection', label: 'Fixture desktop', hostId: 'fixture-host', anchorSHA256: 'fixture-fingerprint',
  ssh: { hostname: 'fixture.invalid', username: 'fixture', port: 22 }, state: 'connected', expiresAt: 4102444800000
}
const alpha = {
  id: 'claude', label: 'Alpha', available: true, modelId: 'alpha-default',
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
  sessions: [{ sessionId: 'old-session', externalSessionId: 'old-native', providerId: 'claude', cwd: '/fixture/project-a', label: 'Old session', ts: 1700000000000 }],
  providerEvidence: 'host_snapshot', directorySelection: true
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
  async catalog() { return structuredClone({ ...catalog, projects: catalog.projects.map(project => ({ ...project, label: project.label + (state.catalogRevision ? ' v2' : '') })), providers: state.hideProvider ? [beta] : catalog.providers, directorySelection: state.oldDirectoryHost ? undefined : true }) },
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
  async history(_id, context) { state.historyCalls.push(contextFor({ context })); return { turns: [], hasOlder: false, source: 'trace_archive', status: 'available' } },
  async trace(_id, context, runId) {
    state.traceCalls.push({ context: contextFor({ context }), runId })
    if (runId === firstScryRun) return activeRun(firstScryRun, 'native-session', 'first remote run', question)
    if (runId === secondScryRun) return activeRun(secondScryRun, 'native-session', 'second remote run', undefined, true)
    return null
  },
  async intents() {
    state.intentsCalls++
    if (state.answerFailure && state.intent?.runId === firstLedger) { state.firstIntentCleared = true; return [] }
    return state.intent ? [state.intent] : []
  },
  async submit(_id, input) {
    state.submitInputs.push(input)
    const first = state.submitInputs.length === 1
    state.intent = { intentId: first ? 'intent-first' : 'intent-second', connectionId: connection.id, context: contextFor(input), createdAt: state.submitInputs.length, status: 'recorded', runId: first ? firstLedger : secondLedger }
    return state.intent
  },
  async intentStatus() { return state.intent },
  async runStatus(_id, runId) {
    if (runId === firstLedger) return { state: 'dispatched', scryRunId: firstScryRun, externalSessionId: 'native-session', detail: 'fixture dispatched' }
    return { state: 'dispatched', scryRunId: secondScryRun, externalSessionId: 'native-session', detail: 'fixture background work' }
  },
  async stop(_id, runId) { state.stopCalls.push(runId) },
  async answer(_id, runId, response) { state.answerCalls.push({ runId, response }); state.answerFailure = true; throw new Error('remote answer rejected') },
  async files() { return { entries: [], truncated: false } },
  async file() { throw new Error('no files in fixture') }
}
const noopSubscribe = () => () => {}
window.scry = {
  // Same minimal full-App bridge contract as session-selection-smoke.tsx.
  activeRun: async () => null, activeRuns: async () => [],
  onTrace: noopSubscribe, onTurnDone: noopSubscribe, onError: noopSubscribe,
  listProjects: async () => [], recentFolders: async () => Array.from({ length: 12 }, (_, index) => '/fixture/recent-' + index),
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => [], listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  usageStats: async () => null, stats: async () => null, focusRun: async () => true,
  newSession: async () => { state.localNewSessions++; return true },
  start: async () => { state.localStarts++; throw new Error('Local execution must not be reached') },
  remoteStatus: async () => ({ enabled: true, hostId: 'local-host', anchorSHA256: 'local-anchor', relayConfigured: true,
    pending: [], devices: [{ deviceId: 'phone', deviceLabel: 'Fixture iPhone', confirmedAt: 1, expiresAt: 4102444800000, revoked: false }] }),
  desktopRemote: api, stopBackgroundTask: async () => { state.backgroundStopCalls++; return { status: 'unavailable', message: 'fixture remote task stop trap' } },
  async remoteDesktopHostStatus() { return state.hostEnabled ? { enabled: true, pairPort: 10001, runPort: 10002 } : { enabled: false } },
  async remoteDesktopHostInvite() { state.hostInviteCalls++; state.hostEnabled = true; return 'scry-desktop1:fixture' },
  async remoteDesktopHostDisable() { state.hostDisableCalls++; state.hostEnabled = false }
}
window.desktopRemoteFixture = state
window.refreshFixtureCatalog = () => refreshRemoteCatalog(connection.id)
window.refreshFixtureConnections = refreshDesktopConnections
for (const type of ['keydown', 'change']) document.addEventListener(type, event => {
  state.uiEvents.push({ type, key: event.key, value: event.target.value, tag: event.target.tagName })
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

async function exercise(contents, pointer, capture) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression, label = expression) => {
    const deadline = Date.now() + 7000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}; DOM=${await read('JSON.stringify({ focus: document.activeElement?.tagName, selects: [...document.querySelectorAll("select")].map(node => ({value:node.value, options:[...node.options].map(option => ({text:option.text, value:option.value}))})), text: document.body.innerText.slice(-2000), events: window.desktopRemoteFixture.uiEvents })')}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const pointFor = (selector, captureReceipt = false) => read(`(${pointer.toString()})(${JSON.stringify(selector)}, { timeoutMs: 7000, scroll: true, captureReceipt: ${captureReceipt} })`)
  const send = (method, params) => contents.debugger.sendCommand(method, params)
  const click = async (selector) => {
    const point = await pointFor(selector, true)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await wait('window.__nativeUiPointerReceipt != null', 'native pointer receipt')
    const receipt = await read('window.__nativeUiPointerReceipt')
    check(receipt.trusted && receipt.targetMatched, `Native pointer missed ${selector}: ${JSON.stringify(receipt)}`)
  }
  const key = async (key, code = key, modifiers = 0) => {
    const virtualKey = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'ArrowDown' ? 40 : key === 'ArrowUp' ? 38 : key.length === 1 ? (key.charCodeAt(0) < 128 ? key.toUpperCase().charCodeAt(0) : 0) : undefined
    const nativeVirtualKeyCode = process.platform === 'darwin'
      ? { Enter: 36, Escape: 53, ArrowDown: 125, ArrowUp: 126, b: 11, f: 3 }[key]
      : virtualKey
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
    if (key.length === 1) await send('Input.dispatchKeyEvent', { type: 'char', key, text: key, unmodifiedText: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
  }
  const insert = (text) => send('Input.insertText', { text })
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
  await click('.desktop-remote__host button:last-child')
  await wait('window.desktopRemoteFixture.hostDisableCalls === 1 && !document.querySelector(".desktop-remote__invite")', 'disable clears invitation')

  // Full production App: the remote session uses the same ChatView as local sessions.
  await click('[data-app-fixture]')
  const remoteShown = 'document.querySelector(".execution-location.is-remote") != null'
  const sendDisabled = 'document.querySelector(".runtime-composer button.send").disabled'
  const composerValue = 'document.querySelector(\'textarea[aria-label="描述任务"]\').value'
  await wait('document.querySelector(".sb-hosts .sb-nav-count")?.textContent === "1/1"', 'hosts nav connected count')
  await wait('document.querySelector(".sb-remote-proj .sb-host-tag")?.textContent === "Fixture desktop"', 'remote project tagged with host in sidebar')
  await wait('document.querySelector(".location-button") != null', 'machine + project picker in composer')
  const localBefore = (await fixture()).localNewSessions
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
  check((await fixture()).historyCalls.length === 0, 'New remote draft queried history before a session existed')

  await wait('document.querySelector(".permission-mode-trigger .rc-value")?.textContent === "Default · Fixture desktop"', 'host-named default permission')
  await click('.permission-mode-trigger')
  await wait('document.querySelector(".permission-mode-option.is-danger") != null', 'permission options')
  check(await read('document.querySelector(".permission-mode-option.is-danger").textContent.includes("Full access · Fixture desktop")'), 'Full access copy does not name the executing host')
  await click('.permission-mode-option.is-danger')
  await wait('document.querySelector(".permission-mode-trigger .rc-value")?.textContent === "Full access · Fixture desktop"', 'full_access permission selection')
  await click('textarea[aria-label="描述任务"]')
  await read(`(() => { const node = document.querySelector('textarea[aria-label="描述任务"]'); node.select() })()`)
  await insert('first prompt')
  await key('Enter')
  await key('Enter')
  await wait('window.desktopRemoteFixture.submitInputs.length === 1', 'double Enter submit')
  const afterFirstSubmit = await fixture()
  check(afterFirstSubmit.submitInputs.length === 1, 'Double Enter submitted more than once')
  check(afterFirstSubmit.submitInputs[0].prompt === 'first prompt', 'Remote submit did not send the composer text')
  check(afterFirstSubmit.submitInputs[0].permissionMode === 'full_access', 'Selected permission was not submitted')
  check(afterFirstSubmit.submitInputs[0].context.externalSessionId === undefined, 'First message unexpectedly had a native session')
  await wait('window.desktopRemoteFixture.traceCalls.some(call => call.runId === "remote-run-fixture-1")', 'canonical trace lookup')
  await wait('document.querySelector(".question-inline-form") != null', 'remote question')
  check(await read('document.querySelector(".clibtn").disabled'), 'Adopted session must keep its Provider identity')

  await click('.run-status-stop')
  await wait('window.desktopRemoteFixture.stopCalls.length === 1', 'remote stop')
  check((await fixture()).stopCalls[0] === '11111111-1111-4111-8111-111111111111', 'Stop did not use the ledger intent UUID')
  await click('.question-option input[type="radio"]')
  await click('.question-submit')
  await wait('document.querySelector(".question-error")?.textContent.includes("remote answer rejected")', 'stable answer failure')
  const afterAnswer = await fixture()
  check(afterAnswer.answerCalls.length === 1 && afterAnswer.answerCalls[0].runId === '11111111-1111-4111-8111-111111111111', 'Answer did not use the ledger intent UUID')
  check(!(await bodyText()).includes('已发送回答'), 'Failed answer was rendered as success')
  await wait('window.desktopRemoteFixture.firstIntentCleared === true', 'clear first intent')

  await wait('document.querySelector(".run-status") == null', 'first run no longer blocks the composer')
  await click('textarea[aria-label="描述任务"]')
  await insert('next prompt after native adoption')
  await key('Enter')
  await wait('window.desktopRemoteFixture.submitInputs.length === 2', 'next message')
  check((await fixture()).submitInputs[1].context.externalSessionId === 'native-session', 'New native session was not adopted for the next message')
  await wait('window.desktopRemoteFixture.traceCalls.some(call => call.runId === "remote-run-fixture-2")', 'second remote run trace')
  await wait('document.body.textContent.includes("second remote run")', 'second remote run displayed')
  check((await bodyText()).includes('remote background task'), 'Remote background task panel was not visible')
  check(!(await read('document.querySelector("[aria-label^=\\"停止任务\\"]")')), 'Remote background task exposed a task-stop control')
  check((await fixture()).backgroundStopCalls === 0, 'Remote background task reached stopBackgroundTask while visible')
  check(!(await read('document.querySelector(".location-button")')), 'Existing remote session exposed the location picker')

  // New conversation stays on the current machine and project.
  await click('.sb-new')
  // Controls reset in an effect after remount; wait for the settled default so coordinates stay valid.
  await wait('!document.querySelector(".clibtn").disabled && !document.body.textContent.includes("second remote run") && document.querySelector(".model-effort-model")?.textContent === "Alpha Default"', 'new draft on same machine unlocks execution context')
  check(await read(remoteShown), 'New conversation left the remote machine')
  check(await read('document.querySelector(".location-button").getAttribute("aria-label") === "执行位置：Fixture desktop / /fixture/project-a"'), 'New conversation changed the project')
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
  check(!(await read('document.querySelector(".sb-hosts .sb-nav-count")')), 'Read failure showed a host count')
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
  await wait('document.querySelector(".composer-notice button") != null', 'offline before Provider removal')
  await click('.composer-notice button')
  await wait('document.querySelector(".clibtn")?.textContent.includes("原 Provider")', 'missing Provider is not replaced')
  check(await read(sendDisabled), 'Missing Provider allowed submission')
  await read('window.desktopRemoteFixture.connected = false; window.desktopRemoteFixture.hideProvider = false')
  await wait('document.querySelector(".composer-notice button") != null', 'offline before Provider restore')
  await click('.composer-notice button')
  await wait(`!${sendDisabled}`, 'original Provider restored')

  // Back to this Mac: a new draft picks the local machine; local new sessions stay intact.
  await click('.sb-new')
  await wait('document.querySelector(".location-button") != null', 'remote new draft location picker')
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
  check(!(await read('document.querySelector(".remote-client-settings").textContent.includes("Fixture iPhone")')), 'Inbound grants mixed into outbound hosts')
  await capture('remote-settings')
  await click('.remote-client-settings button')
  await wait('!document.querySelector(".settings-modal") && document.querySelector(".hosts-view") != null', 'settings opens hosts page')
  check(await read('document.querySelector(\'.hosts-section[aria-label="我连接的主机"]\').textContent.includes("Fixture desktop")'), 'Hosts page omitted outbound host')
  check(!(await read('document.querySelector(\'.hosts-section[aria-label="我连接的主机"]\').textContent.includes("Fixture iPhone")')), 'Hosts page mixed inbound devices into outbound hosts')
  await wait('document.querySelector(\'.hosts-section[aria-label="允许其他设备访问本机"]\')?.textContent.includes("Fixture iPhone")', 'hosts page inbound section')
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
  await wait('window.desktopRemoteFixture.connected && document.querySelector(".sb-hosts .sb-nav-count")?.textContent === "1/1"', 'explicit reconnect after editing')
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
  await wait('document.querySelector(".composer-notice button") != null', 'bound session disconnect')
  await click('.composer-notice button')
  await wait('document.querySelector(".sb-remote-proj .pname")?.textContent === "Project A v2"', 'reconnect refreshes catalog alongside bound-session history')

  return {
    remoteDirectoryPicker: { oldHostUnavailable: true, cancelFocusAndDraft: true, browseDoesNotGrant: true, invalidPath: true, pagination: true, offlineBlocked: true, uncertainGrantVisible: true, explicitSelectionOnly: true, noImplicitSend: true },
    locationHoverStable: { menu: true, machineRows: true, stationaryPointer: true, shortWindow: true, noImplicitSelection: true },
    hostAddressEdit: { cancel: true, focusRestored: true, validation: true, storageFailure: true, doubleEnterSingleSave: true, identityKept: true, explicitReconnect: true, noProviderStart: true },
    boundSessionReconnectRefreshesCatalog: true,
    savedHostsAfterRendererReload: true,
    hostsPageSeparatesConnectionDirections: true,
    removedProviderNeverSubstituted: true,
    sharedChatViewForRemote: true,
    locationPickerCarriesDraft: true,
    hostNamedPermissionCopy: true,
    existingSessionIdentityLocked: true,
    offlineNeverFallsBack: true,
    readFailureKeepsSavedHosts: true,
    reconnectPreservesDraft: true,
    staleDispatchNoticeCleared: true,
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
    plugins: negativeControl || negativeMachineControl || negativeAddressControl || negativeHoverControl ? [{ name: 'remote-negative-control', enforce: 'pre', transform(source, id) {
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
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
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
        })
        console.log('SCRY_DESKTOP_REMOTE_UI_RESULT=' + JSON.stringify(result))
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home'), SCRY_TEST_APP: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let cleanupTimer
    const timer = setTimeout(() => {
      failed = true
      const failure = new Error(`DesktopRemote UI timed out (pid=${child.pid}, fixture=${temp}):\\n${output.slice(-8000)}`)
      console.error(failure.message)
      cleanupTimer = stopOwnedApp(child).then(() => reject(failure), (error) => { cleanupUnknown = true; reject(new Error(`DesktopRemote cleanup unknown; fixture preserved: ${temp}`, { cause: error })) })
    }, 35_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); failed = true; reject(error) })
    child.once('close', (code, signal) => {
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
