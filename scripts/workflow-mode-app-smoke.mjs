import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopOwnedApp, inspectOwnedApp } from './owned-app-processes.mjs'
import { nativeUiPointer } from './native-ui-pointer.mjs'
import { checkWorkflowMessageChoiceApp } from './workflow-message-choice-app-checks.mjs'
import { checkColdWorkflowTemplateEditApp, checkWorkflowTemplateEditApp } from './workflow-template-edit-app-checks.mjs'
import { checkAnalyticsIpcApp } from './analytics-ipc-app-checks.mjs'

// Real main/preload/renderer with the existing opt-in offline adapter. This
// proves the routing contract end to end; it validates no real Provider SDK,
// account or fee.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const evidence = await mkdtemp(join(tmpdir(), 'scry-workflow-mode-app-'))
const home = join(evidence, 'home'), userData = join(evidence, 'userData')
const workspacePath = join(evidence, 'workspace')
await Promise.all([home, userData, workspacePath].map(path => mkdir(path)))
const workspace = await realpath(workspacePath)
await writeFile(join(workspace, 'README.md'), '# Isolated workflow routing acceptance\n')
const inputsFile = join(evidence, 'provider-inputs.jsonl')
const callsFile = join(evidence, 'provider-calls.jsonl')
const candidate = join(evidence, 'workflow-authoring-candidate.json')
// The workspace must already be an authorized project before any conversation exists.
await writeFile(join(userData, 'recent-folders.json'), JSON.stringify([workspace]))
const executable = resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
let child, cdp, closures = []
let stderr = ''

async function freePort() {
  const server = createServer()
  await new Promise((resolvePort, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePort))
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}
function connect(url) {
  const socket = new WebSocket(url), pending = new Map()
  let id = 0
  socket.onmessage = event => {
    const data = JSON.parse(event.data)
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result)
  }
  const send = (method, params = {}) => new Promise((resolveCall, reject) => {
    const commandId = ++id
    pending.set(commandId, { resolve: resolveCall, reject })
    socket.send(JSON.stringify({ id: commandId, method, params }))
  })
  return new Promise((resolveCall, reject) => {
    socket.onopen = () => resolveCall({ send, close: () => socket.close() })
    socket.onerror = reject
  })
}
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function click(selector) {
  const point = await evaluate(`(${nativeUiPointer.toString()})(${JSON.stringify(selector)}, { timeoutMs: 5000, scroll: true, captureReceipt: true })`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  assert.equal(await evaluate('window.__nativeUiPointerReceipt?.trusted && window.__nativeUiPointerReceipt?.targetMatched'), true)
}
async function wait(probe, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await new Promise(done => setTimeout(done, 50))
  }
  throw new Error('Timed out: ' + label)
}
async function launch() {
  const port = await freePort()
  child = spawn(executable, [resolve(root), `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], {
    env: { ...process.env, HOME: home, ELECTRON_ENABLE_LOGGING: '1', SCRY_TEST_APP: '1',
      SCRY_ELECTRON_SMOKE_PROVIDER: '1', SCRY_ELECTRON_SMOKE_WORKFLOW: '1', SCRY_ELECTRON_SMOKE_TASK_FENCE: '1',
      SCRY_ELECTRON_SMOKE_AUTHORING: '1', SCRY_ELECTRON_SMOKE_INPUTS: inputsFile, SCRY_ELECTRON_SMOKE_CALLS: callsFile,
      SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi', SCRY_REMOTE_HOST: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', chunk => { stderr += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  await wait(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (!page || cdp) return false
      cdp = await connect(page.webSocketDebuggerUrl)
      await cdp.send('Runtime.enable')
      return Boolean(await evaluate('Boolean(window.scry?.conversations?.submit)'))
    } catch { return false }
  }, 'production preload conversation API')
}
async function stop() {
  cdp?.close(); cdp = undefined
  if (child) { closures.push(await stopOwnedApp(child)); child = undefined }
}
const readInputs = async () => {
  try {
    const text = (await readFile(inputsFile, 'utf8')).trim()
    return text ? text.split('\n').map(line => JSON.parse(line)) : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
const route = reply => writeFile(candidate, JSON.stringify(reply))
const waitInputs = (count, label) => wait(async () => (await readInputs()).length === count, label)
// The real composer selects the builtin command before sending; a bare prompt
// reaches the same disambiguation the UI performs.
const submit = (conversationId, expectedRevision, prompt, selected = true, override) => evaluate(
  `window.scry.conversations.submit(${JSON.stringify({ conversationId, expectedRevision, commandId: randomUUID(), prompt,
    ...(selected ? { selectedCommandId: 'scry:workflow' } : {}),
    message: { providerId: 'codex', expectedContinuationKey: 'codex:default:smoke:default', confirmFresh: true, selectedItems: [],
      ...(override ? { workflowOverride: override } : {}) } })})`)
const conversationOf = id => evaluate(`window.scry.conversations.list(${JSON.stringify(workspace)}).then(rows => rows.find(row => row.id === ${JSON.stringify(id)}))`)
// A conversation refuses the next write while a turn is still in flight; wait for
// the recorded outcome instead of guessing a delay.
const waitIdle = (id, label) => wait(async () => {
  const row = await conversationOf(id)
  return row && !row.activeRunId && !row.blockedReason ? row : undefined
}, label, 60_000)

const body = { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'call', blockId: 'scan', role: 'orchestrator', prompt: 'inspect the workspace' },
  { kind: 'return', blockId: 'finish', ref: { nodeId: 'scan' } }
] }
let result
try {
  await launch()
  const descriptors = await evaluate('window.scry.providerDescriptors()')
  assert.deepEqual(descriptors.map(entry => [entry.id, entry.transport, entry.available]),
    [['codex', 'packaged smoke fixture', true]], 'only the explicit offline adapter may be registered')
  const created = await evaluate(`window.scry.conversations.create(${JSON.stringify(workspace)})`)
  const conversationId = created.id

  // 0. The real widget renders the stored mode and writes it with a trusted gesture.
  const project = `.sb-proj-head[data-project-path=${JSON.stringify(workspace)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(project)}))`), 'fixture project in real sidebar')
  if (await evaluate(`document.querySelector(${JSON.stringify(project)}).getAttribute('aria-expanded') !== 'true'`)) await click(project)
  const entry = `.sidebar [data-conversation-id=${JSON.stringify(conversationId)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(entry)}))`), 'new synthetic conversation in sidebar')
  await click(entry)
  await wait(() => evaluate(`document.querySelector('.conversation-chat')?.dataset.conversationId === ${JSON.stringify(conversationId)}`), 'conversation view')
  await click('details.conversation-options:has([data-workflow-mode=conversation]) > summary')
  await wait(() => evaluate(`document.querySelector('[data-workflow-mode=conversation]')?.offsetWidth > 0`), 'visible workflow mode control')
  assert.equal(await evaluate(`document.querySelector('[data-workflow-mode=conversation]').value`), 'off')
  // Every option is present with its cost/limit explanation. The write itself
  // uses the same preload channel the control calls and is asserted below.
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-workflow-mode=conversation] option'), node => [node.value, node.textContent])`),
    [['off', '关闭（不识别，默认）'], ['manual', '手动（识别明确请求，每条消息一次路由）'], ['auto', '自动（每条新消息一次路由调用）']])
  // This proves the control's React handler reaches Main. It is a synthetic
  // change event, not a native select gesture.
  await evaluate(`(() => { const select = document.querySelector('[data-workflow-mode=conversation]');
    select.value = 'manual'; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  assert.equal((await conversationOf(conversationId)).workflowMode, undefined, 'selection alone grants no routing authority')
  assert.equal((await conversationOf(conversationId)).workflowRoutingConsent, undefined)
  await click('[data-workflow-mode=cancel]')
  assert.equal((await conversationOf(conversationId)).workflowRoutingConsent, undefined, 'cancel leaves consent absent')
  await evaluate(`(() => { const select = document.querySelector('[data-workflow-mode=conversation]');
    select.value = 'manual'; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await click('[data-workflow-mode=confirm]')
  const widgetMode = await wait(async () => {
    const row = await conversationOf(conversationId)
    return row?.workflowMode === 'manual' ? row.workflowMode : undefined
  }, 'mode control writes through the preload channel')
  assert.equal(widgetMode, 'manual')
  assert.equal((await readInputs()).length, 0, 'changing the mode never calls a Provider')

  // 1. The mode command is durable conversation state with a main-built grant.
  const widgetState = await conversationOf(conversationId)
  const enabled = await submit(conversationId, widgetState.revision, '/scry-workflow mode auto')
  assert.equal(enabled.kind, 'control')
  assert.equal(enabled.action, 'mode_updated')
  assert.equal(enabled.mode, 'auto')
  const afterMode = await conversationOf(conversationId)
  assert.equal(afterMode.workflowMode, 'auto')
  assert.equal((await readInputs()).length, 0, 'a mode command never calls a Provider')

  // 2. `direct` spends one routing call, then the ordinary message is sent.
  await route({ route: 'direct' })
  const direct = await submit(conversationId, afterMode.revision, 'what does README.md say?', false)
  const afterDirect = await waitIdle(conversationId, 'first ordinary turn settled')
  assert.equal(direct.kind, 'direct')
  await waitInputs(2, 'one routing call plus one ordinary turn')
  const directInputs = await readInputs()
  assert.equal(directInputs[0].purpose, 'workflow_authoring')
  assert.match(directInputs[0].prompt, /routing one new message/)
  assert.equal(directInputs[1].prompt, 'what does README.md say?')

  // 3. `workflow` returns a draft for approval and dispatches nothing.
  await route({ route: 'workflow', body })
  const routed = await submit(conversationId, afterDirect.revision, 'sequence the review work', false)
  assert.equal(routed.kind, 'control')
  assert.equal(routed.action, 'open_workflow_routed')
  assert.equal(routed.preview.state, 'ready')
  assert.equal(routed.preview.userGoal, 'sequence the review work')
  assert.match(routed.preview.programRevision, /^[a-f0-9]{64}$/)
  await waitInputs(3, 'routing adds exactly one call')
  const records = await readdir(join(userData, 'workflows'))
  assert.ok(records.includes(`${routed.preview.workflowId}.json`), 'a draft root is published')
  const published = JSON.parse(await readFile(join(userData, 'workflows', `${routed.preview.workflowId}.json`), 'utf8'))
  assert.equal(published.progress.state, 'awaiting_approval', 'the durable root waits for approval')
  assert.equal(published.progress.dispatchAttempts, 0, 'a routed draft cannot dispatch before approval')
  const preview = await evaluate(`window.scry.workflow.preview(${JSON.stringify(routed.preview.workflowId)})`)
  assert.equal(preview.programRevision, routed.preview.programRevision)
  assert.equal(preview.state, 'ready')

  // 4. `clarification` asks instead of guessing, and still dispatches nothing.
  const afterRouted = await conversationOf(conversationId)
  await route({ route: 'clarification', question: 'Which repository should this cover?' })
  const clarified = await submit(conversationId, afterRouted.revision, 'fix everything', false)
  assert.equal(clarified.kind, 'rejected')
  assert.equal(clarified.error, 'Which repository should this cover?')
  await waitInputs(4, 'clarification adds exactly one call')

  // 4b. A per-send override is consumed by this request only.
  const afterClarified = await conversationOf(conversationId)
  const forcedDirect = await submit(conversationId, afterClarified.revision, 'answer this one directly', false, 'direct')
  assert.equal(forcedDirect.kind, 'direct')
  await waitInputs(5, 'direct override adds no routing call')
  const afterForced = await waitIdle(conversationId, 'override turn settled')
  const forcedWorkflow = await submit(conversationId, afterForced.revision, 'plan this one as a workflow', false, 'workflow')
  assert.equal(forcedWorkflow.kind, 'control')
  assert.equal(forcedWorkflow.action, 'open_workflow_planner')
  assert.equal(forcedWorkflow.command, '/scry-workflow run plan this one as a workflow')
  assert.equal((await readInputs()).length, 5, 'a workflow override captures a task, it does not plan yet')

  // 5. Manual recognizes explicit intent once; ordinary messages still go direct.
  const beforeManual = await conversationOf(conversationId)
  const manual = await submit(conversationId, beforeManual.revision, '/scry-workflow mode manual')
  assert.equal(manual.action, 'mode_updated')
  assert.equal(manual.mode, 'manual')
  const afterManual = await conversationOf(conversationId)
  await route({ route: 'direct' })
  const plain = await submit(conversationId, afterManual.revision, 'plain manual message', false)
  assert.equal(plain.kind, 'direct')
  await waitInputs(7, 'manual direct uses one router and one ordinary call')
  await waitIdle(conversationId, 'manual direct turn settled')
  const manualInputs = await readInputs()
  assert.equal(manualInputs[5].purpose, 'workflow_authoring')
  assert.match(manualInputs[5].prompt, /MANUAL/)
  assert.equal(manualInputs[6].prompt, 'plain manual message')
  await route({ route: 'workflow', body })
  const beforeManualWorkflow = await conversationOf(conversationId)
  const manualWorkflow = await submit(conversationId, beforeManualWorkflow.revision, 'please use a workflow for this task', false)
  assert.equal(manualWorkflow.action, 'open_workflow_routed')
  await waitInputs(8, 'manual explicit workflow only routes once')
  const manualRoot = await evaluate(`window.scry.workflow.snapshot(${JSON.stringify(manualWorkflow.preview.workflowId)})`)
  assert.equal(manualRoot.state, 'awaiting_approval')
  assert.equal(manualRoot.dispatchAttempts, 0)

  result = { mode: { enabled, manual }, routed: { workflowId: routed.preview.workflowId, programRevision: routed.preview.programRevision,
    state: published.progress.state, dispatchAttempts: published.progress.dispatchAttempts }, direct: directInputs.length, clarification: clarified.error,
    override: { direct: forcedDirect.kind, workflow: forcedWorkflow.command },
    manualRecognition: { consentConfirmed: true, direct: plain.kind, workflow: manualWorkflow.action, dispatchAttempts: manualRoot.dispatchAttempts },
    providerCalls: (await readInputs()).length, offlineAdapter: descriptors[0].transport, realSdkOrAccount: 'unverified' }
  await stop()

  // 6. Cold restart keeps the stored mode and replays nothing.
  await launch()
  const cold = await conversationOf(conversationId)
  assert.equal(cold.workflowMode, 'manual')
  assert.equal(cold.id, conversationId)
  assert.equal((await readInputs()).length, 8, 'cold observation cannot replay a routing or Agent call')
  const composer = await checkWorkflowMessageChoiceApp({ evaluate, click, wait, input: (method, params) => cdp.send(method, params),
    submit, conversationOf, waitIdle, readInputs, conversationId })
  await stop()
  await launch()
  const afterComposerRestart = await conversationOf(conversationId)
  assert.equal(afterComposerRestart.workflowMode, 'manual')
  assert.equal((await readInputs()).length, composer.providerCalls, 'restart cannot replay a per-message override')
  const templateEdit = await checkWorkflowTemplateEditApp({ evaluate, click, wait, input: (method, params) => cdp.send(method, params),
    submit, conversationOf, readInputs, route, conversationId })
  await stop()
  await launch()
  const afterEditRestart = await conversationOf(conversationId)
  const afterEditCalls = (await readInputs()).length
  assert.equal(afterEditRestart.workflowMode, 'manual')
  assert.equal(afterEditCalls, templateEdit.providerCalls, 'cold edit observation cannot spend another call')
  await checkColdWorkflowTemplateEditApp({ evaluate, readInputs, conversationId, templateEdit, expectedCalls: afterEditCalls })
  const analytics = await checkAnalyticsIpcApp({ evaluate, readInputs })
  await writeFile(join(evidence, 'routing.json'), JSON.stringify({ ...result, coldWorkflowMode: cold.workflowMode, composer, templateEdit, analytics,
    coldAfterEdit: { mode: afterEditRestart.workflowMode, providerCalls: afterEditCalls },
    coldAfterComposer: { mode: afterComposerRestart.workflowMode, providerCalls: composer.providerCalls } }, null, 2))
} catch (error) {
  if (cdp) await writeFile(join(evidence, 'ui-failure.json'), JSON.stringify(await evaluate(`({
    body: document.body.innerText.slice(-6000), checked: document.querySelector('.conversation-message-choice input:checked')?.value,
    choiceDisabled: document.querySelector('.conversation-message-choice')?.disabled,
    sendDisabled: document.querySelector('button.send')?.disabled, input: document.querySelector('textarea[aria-label="描述任务"]')?.value
  })`), null, 2))
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), stderr, owned: inspectOwnedApp(child) }, null, 2))
  throw error
} finally {
  await stop()
  await writeFile(join(evidence, 'closure.json'), JSON.stringify(closures, null, 2))
  console.log('Workflow routing App evidence: ' + evidence)
}
