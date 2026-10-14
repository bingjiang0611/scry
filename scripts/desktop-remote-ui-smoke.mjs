import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-desktop-remote-ui-'))
const negativeControl = process.argv.includes('--negative-control')
const negativeMachineControl = process.argv.includes('--negative-machine-control')
const keepArtifacts = process.argv.includes('--keep')
let cleanupUnknown = false
let failed = false

// This is a renderer-only contract fixture. The bridge records calls but never starts a
// Provider, opens a socket, reads credentials, or calls the local run-control API.
const fixtureSource = `
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { DesktopRemote, RemoteHostPanel } from ${JSON.stringify(join(root, 'src/renderer/components/DesktopRemote.tsx'))}
import { App } from ${JSON.stringify(join(root, 'src/renderer/App.tsx'))}
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
  localNewSessions: 0, localStarts: 0, listFailure: false, hideProvider: false, catalogRevision: 0
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
  providerEvidence: 'host_snapshot'
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
  async connect() { state.connected = true },
  async disconnect() { state.connected = false },
  async forget() {},
  async catalog() { return structuredClone({ ...catalog, projects: catalog.projects.map(project => ({ ...project, label: project.label + (state.catalogRevision ? ' v2' : '') })), providers: state.hideProvider ? [beta] : catalog.providers }) },
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
  listProjects: async () => [], recentFolders: async () => [],
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
for (const type of ['keydown', 'change']) document.addEventListener(type, event => {
  state.uiEvents.push({ type, key: event.key, value: event.target.value, tag: event.target.tagName })
  if (state.uiEvents.length > 24) state.uiEvents.shift()
}, true)
function Fixture() {
  const [hostView, setHostView] = useState(true)
  const [fullApp, setFullApp] = useState(false)
  if (fullApp) return <App />
  return <>{hostView ? <><RemoteHostPanel /><button data-client-fixture onClick={() => setHostView(false)}>Client fixture</button></> : <DesktopRemote onBack={() => {}} />}
    <button data-app-fixture style={{ position: 'fixed', top: 2, right: 2, zIndex: 9999 }} onClick={() => { state.intent = null; setFullApp(true) }}>Full App</button>
  </>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`

async function exercise(contents, capture) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression, label = expression) => {
    const deadline = Date.now() + 7000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}; DOM=${await read('JSON.stringify({ focus: document.activeElement?.tagName, selects: [...document.querySelectorAll("select")].map(node => ({value:node.value, options:[...node.options].map(option => ({text:option.text, value:option.value}))})), text: document.body.innerText.slice(-2000), events: window.desktopRemoteFixture.uiEvents })')}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const pointFor = async (selector) => read(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)})
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = node.getBoundingClientRect()
    const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    if (rect.width <= 0 || rect.height <= 0 || document.elementFromPoint(point.x, point.y) !== node && !node.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Control is not hit-testable: ' + ${JSON.stringify(selector)} + ' ' + JSON.stringify({ point, width: rect.width, height: rect.height, hit: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 300) }))
    return point
  })()`)
  const send = (method, params) => contents.debugger.sendCommand(method, params)
  const click = async (selector) => {
    const point = await pointFor(selector)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
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
  const fixture = () => read('window.desktopRemoteFixture')
  const bodyText = () => read('document.body.textContent')

  await wait('document.querySelector(".desktop-remote__host button")?.textContent.includes("启用")', 'disabled host enable action')
  await click('.desktop-remote__host button')
  await wait('document.querySelector(".desktop-remote__invite")?.textContent.includes("scry-desktop1:fixture")', 'enabled host invitation')
  check((await fixture()).hostInviteCalls === 1, 'Host enable dispatched more than one invitation')
  await click('.desktop-remote__host button:last-child')
  await wait('window.desktopRemoteFixture.hostDisableCalls === 1 && !document.querySelector(".desktop-remote__invite")', 'disable clears invitation')
  await click('[data-client-fixture]')
  await wait('document.querySelector(\'.desktop-remote__connection\') != null', 'connection list')
  check((await fixture()).historyCalls.length === 0, 'New session queried history before a session existed')
  await click('.desktop-remote__actions button:not([disabled])')
  await wait('document.querySelector(\'.desktop-remote__workspace\') != null', 'workspace')
  await wait('document.querySelector(\'textarea[aria-label="远程提示词"]\') != null', 'composer')
  check((await fixture()).historyCalls.length === 0, 'New session called history without an external session')

  await click('.desktop-remote__controls label:nth-child(3) select')
  await key('f', 'KeyF')
  await key('Enter')
  await wait('document.querySelectorAll(".desktop-remote__controls select")[2]?.value === "full_access"', 'full_access permission selection')
  await click('textarea[aria-label="远程提示词"]')
  await insert('first prompt')
  await key('Enter')
  await key('Enter')
  await wait('window.desktopRemoteFixture.submitInputs.length === 1', 'double Enter submit')
  check((await fixture()).submitInputs.length === 1, 'Double Enter submitted more than once')
  await wait('window.desktopRemoteFixture.traceCalls.some(call => call.runId === "remote-run-fixture-1")', 'canonical trace lookup')
  const afterFirstTrace = await fixture()
  check(afterFirstTrace.traceCalls.some((call) => call.runId === 'remote-run-fixture-1'), 'Trace did not use canonical scryRunId')
  check(afterFirstTrace.submitInputs[0].context.externalSessionId === undefined, 'First message unexpectedly had a native session')
  await wait('window.desktopRemoteFixture.submitInputs.length === 1 && document.querySelector(".question-inline-form") != null', 'remote question')

  await click('.desktop-remote__composer button:last-child')
  await wait('window.desktopRemoteFixture.stopCalls.length === 1', 'remote stop')
  check((await fixture()).stopCalls[0] === '11111111-1111-4111-8111-111111111111', 'Stop did not use the ledger intent UUID')
  await click('.question-option input[type="radio"]')
  await click('.question-submit')
  await wait('document.querySelector(".question-error")?.textContent.includes("remote answer rejected")', 'stable answer failure')
  const afterAnswer = await fixture()
  check(afterAnswer.answerCalls.length === 1 && afterAnswer.answerCalls[0].runId === '11111111-1111-4111-8111-111111111111', 'Answer did not use the ledger intent UUID')
  check(!await read('document.querySelector(".desktop-remote__status")?.textContent.includes("已发送回答")'), 'Failed answer was rendered as success')
  await wait('window.desktopRemoteFixture.firstIntentCleared === true', 'clear first intent')

  await click('textarea[aria-label="远程提示词"]')
  await insert('next prompt after native adoption')
  await key('Enter')
  await wait('window.desktopRemoteFixture.submitInputs.length === 2', 'next message')
  const afterAdoption = await fixture()
  check(afterAdoption.submitInputs[1].context.externalSessionId === 'native-session', 'New native session was not adopted for the next message')
  check(await read('document.querySelector(\'.desktop-remote__sidebar > label:last-of-type select\').value === "native-session"'), 'Adopted session was mislabeled as a new draft before catalog settlement')
  await wait('window.desktopRemoteFixture.traceCalls.some(call => call.runId === "remote-run-fixture-2")', 'second remote run trace')
  check((await bodyText()).includes('second remote run'), 'Second remote run was not displayed before context switch')
  check((await bodyText()).includes('remote background task'), 'Remote background task panel was not visible')
  check(!(await read('document.querySelector("[aria-label^=\\"停止任务\\"]")')), 'Remote background task exposed a task-stop control')
  check((await fixture()).backgroundStopCalls === 0, 'Remote background task reached stopBackgroundTask while visible')

  check(await read('document.querySelector(\'.desktop-remote__sidebar > label:nth-of-type(2) select\').disabled'), 'Existing session must keep its Provider identity')
  await click('.desktop-remote__sidebar > button')
  await wait('!document.querySelector(\'.desktop-remote__sidebar > label:nth-of-type(2) select\').disabled', 'new draft unlocks execution context')
  await click('.desktop-remote__sidebar > label:nth-of-type(2) select')
  check(await read('document.activeElement?.tagName === "SELECT"'), 'Provider select did not receive native focus')
  await key('b', 'KeyB')
  await key('Enter')
  await wait('document.querySelectorAll(".desktop-remote__controls select")[0]?.value === "beta-default" && document.querySelectorAll(".desktop-remote__controls select")[2]?.value === "default"', 'provider control reset: ' + await read('JSON.stringify([...document.querySelectorAll(".desktop-remote__sidebar select")].map(node => node.value))'))
  const afterSwitch = await fixture()
  check((await bodyText()).includes('此上下文暂无会话记录。'), 'Context switch did not clear the previous transcript')
  check(!(await bodyText()).includes('second remote run'), 'Context switch displayed the previous run')
  check(afterSwitch.stopCalls.length === 1, 'Context switch stopped the previous remote run')
  check(afterSwitch.backgroundStopCalls === 0, 'Remote background task reached stopBackgroundTask after context switch')

  // Check that a later poll also respects the switched context. This also ends
  // Chromium's previous native-select typeahead sequence before selecting P.
  await wait(`window.desktopRemoteFixture.intentsCalls > ${afterSwitch.intentsCalls}`, 'next-context poll')
  check(!(await bodyText()).includes('second remote run'), 'A later poll restored the old transcript')
  await click('.desktop-remote__sidebar > label:nth-of-type(2) select')
  await key('p', 'KeyP')
  await wait('document.querySelectorAll(".desktop-remote__controls select")[0]?.value === "alpha-alternate"', 'same-provider alternate profile')
  await click('textarea[aria-label="远程提示词"]')
  await insert('alternate profile prompt')
  await key('Enter')
  await wait('window.desktopRemoteFixture.submitInputs.length === 3', 'alternate profile submit')
  const finalState = await fixture()
  check(finalState.submitInputs[2].context.providerId === 'claude' && finalState.submitInputs[2].context.agentProfileId === 'alternate', 'Same-provider profile selection routed to the wrong runtime')

  await click('[data-app-fixture]')
  await wait('document.querySelector(\'select[aria-label="新会话执行位置"]\')?.options.length === 2', 'saved host in production App sidebar')
  const localBefore = (await fixture()).localNewSessions
  await click('select[aria-label="新会话执行位置"]')
  await key('f', 'KeyF'); await key('Enter')
  await wait('document.querySelector(\'select[aria-label="新会话执行位置"]\').value === "fixture-connection"', 'select remote execution location')
  check(!await read('!!document.querySelector(".desktop-remote__workspace")'), 'Changing draft target changed the existing conversation')
  await click('.sb-new')
  await wait(`window.desktopRemoteFixture.localNewSessions > ${localBefore} || document.querySelector('.desktop-remote__workspace') != null`, 'new session route')
  check((await fixture()).localNewSessions === localBefore, 'Remote new session called local newSession')
  await wait('document.querySelector(\'textarea[aria-label="远程提示词"]\') != null', 'remote composer in full App')
  check((await bodyText()).includes('执行位置：Fixture desktop · 远程'), 'Remote machine identity missing from conversation')
  check((await bodyText()).includes('本机会话'), 'Local history lacks machine identity')

  // Transport state changes are fixture events, not programmatic UI clicks.
  await read('window.desktopRemoteFixture.connected = false')
  await wait('document.querySelector(".saved-remote-host__state")?.textContent === "未连接"', 'SSH exit reflected in sidebar')
  await click('textarea[aria-label="远程提示词"]'); await insert('unsent offline draft'); await key('Enter')
  check((await fixture()).submitInputs.length === 3 && (await fixture()).localStarts === 0, 'Offline remote draft reached a Provider')
  check(await read('document.querySelector(".desktop-remote__composer button").disabled'), 'Offline remote send is enabled')
  await read('window.desktopRemoteFixture.listFailure = true')
  await wait('document.querySelector(".saved-remote-host__state")?.textContent === "状态未知"', 'read failure is not an empty or connected list')
  check(await read('document.querySelector(".saved-remote-host").textContent.includes("Fixture desktop")'), 'Read failure forgot saved host')
  await read('window.desktopRemoteFixture.listFailure = false')
  await wait('document.querySelector(".saved-remote-host__state")?.textContent === "未连接"', 'read recovery')
  await click('.desktop-remote__workspace-head button')
  await wait('!document.querySelector(".desktop-remote__composer button").disabled', 'explicit reconnect')
  check(await read('document.querySelector(\'textarea[aria-label="远程提示词"]\').value === "unsent offline draft"'), 'Reconnect discarded the draft')
  check((await fixture()).submitInputs.length === 3, 'Reconnect automatically resubmitted a draft')

  await capture('remote-workspace')
  await read('window.desktopRemoteFixture.hideProvider = true')
  await click('.desktop-remote__workspace-head button:last-child')
  await wait('document.querySelector(\'.desktop-remote__sidebar > label:nth-of-type(2) select\')?.selectedOptions[0]?.textContent.includes("原 Provider")', 'missing Provider is not replaced')
  check(await read('document.querySelector(".desktop-remote__composer button").disabled'), 'Missing Provider allowed submission')
  await read('window.desktopRemoteFixture.hideProvider = false')
  await click('.desktop-remote__workspace-head button:last-child')
  await wait('!document.querySelector(".desktop-remote__composer button").disabled', 'original Provider restored')

  await click('select[aria-label="新会话执行位置"]'); await key('本'); await key('Enter')
  await wait('document.querySelector(\'select[aria-label="新会话执行位置"]\').value === "local"', 'local draft target')
  await click('.sb-new')
  await wait(`window.desktopRemoteFixture.localNewSessions === ${localBefore + 1}`, 'local new-session route remains intact')
  check(!await read('!!document.querySelector(".desktop-remote__workspace")'), 'Local new session retained the remote composer')
  check((await fixture()).localStarts === 0, 'New-session selection started an unrequested local model')

  await click('.sb-settings')
  await click('.settings-rail button:last-child')
  await wait('document.querySelector(".remote-pairing")?.textContent.includes("Fixture iPhone")', 'inbound device grant')
  check(await read('document.querySelector(".remote-client-settings").textContent.includes("Fixture desktop")'), 'Settings omitted outbound host')
  check(!await read('document.querySelector(".remote-client-settings").textContent.includes("Fixture iPhone")'), 'Inbound grants mixed into outbound hosts')
  await capture('remote-settings')
  await click('.remote-client-settings .saved-remote-host')
  await wait('!document.querySelector(".settings-modal") && !!document.querySelector(".desktop-remote__workspace")', 'settings opens host in main view')

  await new Promise(resolve => { contents.once('did-finish-load', resolve); contents.reload() })
  await wait('document.querySelector("[data-app-fixture]") != null', 'fixture reload')
  await click('[data-app-fixture]')
  await wait('document.querySelector(".saved-remote-host")?.textContent.includes("Fixture desktop")', 'saved hosts after renderer reload')
  await click('.saved-remote-host')
  await wait('document.querySelector(".desktop-remote__workspace-head")?.textContent.includes("Fixture desktop")', 'sidebar host opens workspace')

  await wait('document.querySelector(\'.desktop-remote__sidebar > label:last-of-type select\')?.options.length === 2', 'existing remote session')
  await click('.desktop-remote__sidebar > label:last-of-type select'); await key('o', 'KeyO'); await key('Enter')
  await wait('document.querySelector(\'.desktop-remote__sidebar > label:nth-of-type(2) select\').disabled', 'bound session context')
  await read('window.desktopRemoteFixture.connected = false; window.desktopRemoteFixture.catalogRevision = 1')
  await wait('document.querySelector(".saved-remote-host__state")?.textContent === "未连接"', 'bound session disconnect')
  await click('.desktop-remote__workspace-head button')
  await wait('document.querySelector(\'.desktop-remote__sidebar > label:first-of-type select\')?.selectedOptions[0]?.textContent === "Project A v2"', 'reconnect refreshes catalog alongside bound-session history')

  return {
    boundSessionReconnectRefreshesCatalog: true,
    savedHostsAfterRendererReload: true,
    settingsSeparatesConnectionDirections: true,
    removedProviderNeverSubstituted: true,
    fullAppMachineRouting: true,
    existingSessionIdentityLocked: true,
    offlineNeverFallsBack: true,
    readFailureKeepsSavedHosts: true,
    reconnectPreservesDraft: true,
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
    plugins: negativeControl || negativeMachineControl ? [{ name: 'remote-negative-control', enforce: 'pre', transform(source, id) {
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
        const result = await (${exercise.toString()})(win.webContents, async name => {
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
