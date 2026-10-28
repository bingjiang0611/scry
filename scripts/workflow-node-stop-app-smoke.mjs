import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath, readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeUiPointer } from './native-ui-pointer.mjs'
import { stopOwnedApp, inspectOwnedApp } from './owned-app-processes.mjs'
import { writeNativeStopFixture, exerciseNativeNodeStop, verifyNativeNodeStopCold } from './workflow-node-stop-native-checks.mjs'
import { exerciseWorkflowSizePreferences, verifyWorkflowSizePreferencesCold } from './workflow-size-app-checks.mjs'
import { exerciseFrameInspection } from './workflow-frame-app-checks.mjs'
import { exerciseWorkflowExecutionInspection } from './workflow-execution-app-checks.mjs'
import { verifyRecordedOutputsCold } from './workflow-output-app-checks.mjs'
import { exerciseParallelFailurePolicy, verifyParallelFailurePolicyCold } from './workflow-parallel-app-checks.mjs'
import { writeNodeTestAppFixtures, exerciseNodeTestAppEvidence, verifyNodeTestAppEvidenceCold } from './workflow-node-test-app-checks.mjs'

// Actual production main/preload/renderer; only the existing opt-in Provider
// adapter is offline. This does not validate any real Provider SDK or account.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const evidence = await mkdtemp(join(tmpdir(), 'scry-workflow-node-stop-app-'))
const home = join(evidence, 'home'), userData = join(evidence, 'userData')
const workspacePath = join(evidence, 'workspace')
await Promise.all([home, userData, workspacePath].map(path => mkdir(path)))
const workspace = await realpath(workspacePath)
const inputsFile = join(evidence, 'provider-inputs.jsonl')
const run = promisify(execFile)
const gitEnv = { PATH: process.env.PATH, HOME: home, LANG: 'C', LC_ALL: 'C' }
await writeFile(join(workspace, 'README.md'), '# Isolated node stop acceptance\n')
await writeNativeStopFixture(workspace)
await writeNodeTestAppFixtures(workspace)
await run('git', ['init', '--quiet'], { cwd: workspace, env: gitEnv })
await run('git', ['add', 'README.md', 'native-stop.cjs', 'tap-pass.test.cjs', 'tap-skip.test.cjs'], { cwd: workspace, env: gitEnv })
await run('git', ['-c', 'user.name=bingjiang0611', '-c', 'user.email=307659028+bingjiang0611@users.noreply.github.com', 'commit', '--quiet', '-m', 'seed isolated fixture'], { cwd: workspace, env: gitEnv })
await writeFile(join(userData, 'recent-folders.json'), JSON.stringify([workspace]))
await writeFile(join(userData, 'app-sessions.json'), JSON.stringify([{
  sessionId: 'node-stop-seed', runId: 'node-stop-seed', providerId: 'codex', runtimeProvider: 'codex_cli',
  cwd: workspace, preview: 'isolated node stop fixture', ts: Date.now()
}]))

async function wait(probe, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out: ' + label)
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function connect(url) {
  const socket = new WebSocket(url), pending = new Map()
  let next = 0
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)), item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.error) item.reject(new Error(JSON.stringify(message.error)))
    else item.resolve(message.result)
  }
  socket.onclose = () => { for (const item of pending.values()) item.reject(new Error('CDP closed')); pending.clear() }
  return {
    async send(method, params = {}) {
      await ready
      const id = ++next
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    close: () => socket.close()
  }
}

let child, cdp, stderr = ''
const closures = []
async function launch() {
  const port = await freePort()
  child = spawn(join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [root,
    `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'
  ], { cwd: root, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: process.env.LANG,
    HOME: home, ELECTRON_ENABLE_LOGGING: '1', SCRY_TEST_APP: '1', SCRY_ELECTRON_SMOKE_PROVIDER: '1',
    SCRY_ELECTRON_SMOKE_WORKFLOW: '1', SCRY_ELECTRON_SMOKE_INPUTS: inputsFile,
    SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi', SCRY_REMOTE_HOST: '0' }, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-32_000) })
  const page = await wait(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('App exited during startup: ' + stderr)
    let response
    try { response = await fetch(`http://127.0.0.1:${port}/json/list`) } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return false
      throw error
    }
    const targets = await response.json()
    return targets.find(target => target.type === 'page' && target.title === 'Scry' && target.webSocketDebuggerUrl)
  }, 'production App target')
  cdp = connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await wait(() => evaluate('Boolean(window.scry?.workflow?.stopNode)'), 'production preload stopNode')
  const descriptors = await evaluate('window.scry.providerDescriptors()')
  assert.equal(descriptors.length, 1, 'only the explicit offline adapter may be registered')
  assert.equal(descriptors[0].id, 'codex')
  assert.equal(descriptors[0].transport, 'packaged smoke fixture')
  assert.equal(descriptors[0].available, true)
  await writeFile(join(evidence, 'offline-provider.json'), JSON.stringify(descriptors, null, 2))
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

async function stop() {
  cdp?.close(); cdp = undefined
  if (child) {
    closures.push(await stopOwnedApp(child))
    child = undefined
  }
}

const json = JSON.stringify
const workflow = (method, ...args) => evaluate(`window.scry.workflow[${json(method)}](${args.map(json).join(',')})`)
const readInputs = async () => (await readFile(inputsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
async function artifactPaths(directory) {
  const paths = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await artifactPaths(path))
    else {
      assert.ok(entry.isFile(), 'build artifacts must be regular files: ' + path)
      paths.push(path)
    }
  }
  return paths
}
const hashes = {}
const artifacts = (await Promise.all(['out/main', 'out/preload', 'out/renderer'].map(artifactPaths))).flat()
for (const path of [...artifacts, 'src/renderer/components/WorkflowNodeStopButton.tsx', 'src/renderer/components/WorkflowFrameInspector.tsx', 'src/renderer/constants/workflow-frame-copy.ts', 'scripts/workflow-frame-app-checks.mjs', 'scripts/workflow-parallel-app-checks.mjs', 'scripts/workflow-policy-ui-checks.mjs', 'scripts/workflow-size-app-checks.mjs', 'scripts/workflow-size-ui-checks.mjs', 'src/renderer/components/WorkflowSizePreference.tsx', 'src/renderer/constants/copy.ts']) {
  hashes[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')
}
let result
try {
  await launch()
  const project = `.sb-proj-head[data-project-path=${json(workspace)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(project)}))`), 'fixture project in real sidebar')
  if (await evaluate(`document.querySelector(${json(project)}).getAttribute('aria-expanded') !== 'true'`)) await click(project)
  const conversation = await evaluate(`window.scry.conversations.create(${json(workspace)})`)
  const entry = `.sidebar [data-conversation-id=${json(conversation.id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(entry)}))`), 'new synthetic conversation')
  await click(entry)
  await wait(() => evaluate(`document.querySelector('.conversation-chat')?.dataset.conversationId === ${json(conversation.id)}`), 'actual conversation view')
  const definition = { schemaVersion: 1, templateId: 'node-stop-app-fixture', name: 'Isolated node stop fixture', description: 'Offline acceptance only', parameters: {}, roles: [{ role: 'worker', providerId: 'codex' }],
    body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'parallel', blockId: 'siblings', blocks: [
      { kind: 'call', blockId: 'hold', role: 'worker', prompt: 'native composer stop-immediate fixture' },
      { kind: 'call', blockId: 'sibling', role: 'worker', prompt: 'native composer complete fixture' }
    ] }, { kind: 'return', blockId: 'report', ref: { nodeId: 'sibling' } }] } }
  const draft = await evaluate(`window.scry.workflow.templates.saveDraft(${json({ scope: { kind: 'personal' }, source: JSON.stringify(definition) })})`)
  assert.equal(draft.validation.state, 'valid', JSON.stringify(draft.validation))
  const preview = await workflow('instantiateTemplate', {
    source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash },
    commandId: 'node-stop-app-instance', cwd: workspace, userGoal: 'Stop only the held sibling', parameters: {},
    orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [{ role: 'worker', providerId: 'codex' }]
  })
  assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
  const id = preview.workflowId
  const approval = { workflowId: id, programRevision: preview.programRevision, approvedAt: Date.now() }
  assert.equal(await workflow('approve', approval), true)
  await evaluate(`window.__nodeStopRun = window.scry.workflow.start(${json(id)}, ${json(approval)}, 'node-stop-app-start').then(progress => { window.__nodeStopFinal = progress }, error => { window.__nodeStopError = String(error) }); true`)
  const active = await wait(async () => {
    const progress = await workflow('snapshot', id)
    if (await evaluate('window.__nodeStopError')) throw new Error(await evaluate('window.__nodeStopError'))
    const held = progress?.attempts.find(attempt => attempt.nodeId === 'hold')
    const sibling = progress?.attempts.find(attempt => attempt.nodeId === 'sibling')
    return held && !held.settled && sibling?.state === 'completed' && sibling.settled ? { progress, held, sibling } : false
  }, 'independent sibling completes while selected execution is held')
  assert.equal((await readInputs()).length, 2, 'only the two explicitly admitted offline calls')
  const card = `[data-workflow-id=${json(id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(card)}))`), 'production workflow card')
  if (!await evaluate(`document.querySelector(${json(card)}).open`)) await click(card + ' summary')
  const target = card + ` [data-workflow-target=${json(active.held.attemptId)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(target)}))`), 'real node stop control')
  const frameInspection = await exerciseFrameInspection({ workflow, evaluate, wait, click, cdp, workflowId: id,
    recordPath: join(userData, 'workflows', id + '.json'), attempt: active.held, evidence })
  assert.equal((await readInputs()).length, 2, 'read-only frame navigation cannot dispatch an Agent')
  const before = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'before-stop.png'), Buffer.from(before.data, 'base64'))
  await click(target)
  await wait(() => evaluate('Boolean(window.__nodeStopFinal)'), 'actual owned execution convergence')
  const final = await workflow('snapshot', id)
  const record = JSON.parse(await readFile(join(userData, 'workflows', id + '.json'), 'utf8'))
  const selected = record.outcomes.find(outcome => outcome.attemptId === active.held.attemptId)
  const sibling = record.outcomes.find(outcome => outcome.attemptId === active.sibling.attemptId)
  assert.equal(selected.state, 'stopped')
  assert.equal(selected.settled, true)
  assert.equal(sibling.state, 'completed')
  assert.equal(sibling.settled, true)
  assert.equal(record.intents.length, 2)
  assert.equal(record.progress.dispatchAttempts, 2)
  assert.equal(record.execution.segments.length, 1)
  assert.equal(record.stopRequests.length, 1)
  assert.deepEqual(record.stopRequests[0].target, { kind: 'attempt', id: active.held.attemptId })
  assert.ok(record.outcomes.every(outcome => !Object.hasOwn(outcome, 'stopRequested')), 'control projection cannot mutate canonical outcomes')
  assert.notEqual(final.state, 'completed')
  const commandId = record.stopRequests[0].commandId
  assert.equal(await workflow('stopNode', id, { id: active.held.attemptId, kind: 'attempt' }, commandId), true)
  assert.equal((await readInputs()).length, 2)
  const after = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'after-stop.png'), Buffer.from(after.data, 'base64'))
  const native = await exerciseNativeNodeStop({ workflow, evaluate, wait, click, workspace, userData, evidence })
  assert.equal((await readInputs()).length, 2, 'native-only program cannot dispatch an Agent')
  const nodeTests = await exerciseNodeTestAppEvidence({ workflow, evaluate, wait, click, workspace, userData, evidence })
  assert.equal((await readInputs()).length, 2, 'Node test evidence cannot dispatch an Agent')
  const executionInspection = await exerciseWorkflowExecutionInspection({ workflow, evaluate, wait, click,
    workflowId: native.workflowId, agentWorkflowId: id, userData, evidence, readInputs })
  const nodeTestView = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'node-test-evidence.png'), Buffer.from(nodeTestView.data, 'base64'))
  await stop()
  await launch()
  await assert.rejects(() => workflow('stopNode', id, { kind: 'attempt', id: active.sibling.attemptId }, commandId))
  const rejected = JSON.parse(await readFile(join(userData, 'workflows', id + '.json'), 'utf8'))
  assert.deepEqual(rejected.stopRequests, record.stopRequests, 'a cold wrong-target command cannot rewrite an accepted stop receipt')
  assert.equal(await workflow('stopNode', id, { kind: 'attempt', id: active.held.attemptId }, commandId), true)
  const cold = await workflow('snapshot', id)
  assert.equal(cold.attempts.find(attempt => attempt.attemptId === active.held.attemptId).stopRequested.commandId, commandId)
  assert.equal(cold.dispatchAttempts, 2)
  const coldFrame = await workflow('inspectFrame', id, frameInspection.frameId)
  assert.equal(coldFrame.state, 'available')
  assert.equal(coldFrame.frame.nodeId, 'hold')
  assert.deepEqual(coldFrame.frame.parentage, { state: 'available', frameId: frameInspection.parentFrameId })
  assert.equal((await readInputs()).length, 2, 'cold replay cannot redispatch a Provider call')
  await verifyNativeNodeStopCold(workflow, native)
  await verifyNodeTestAppEvidenceCold(workflow, nodeTests)
  const coldExecution = await workflow('inspectExecution', { workflowId: native.workflowId,
    programRevision: executionInspection.programRevision, kind: 'systems' })
  assert.equal(coldExecution.state, 'available')
  assert.deepEqual(coldExecution.records, executionInspection.records, 'cold read preserves exact canonical history')
  await verifyRecordedOutputsCold(workflow, executionInspection.output)
  executionInspection.coldHistoryPreserved = true
  await writeFile(join(evidence, 'execution-inspection.json'), JSON.stringify(executionInspection, null, 2))
  assert.equal((await readInputs()).length, 2, 'cold native evidence cannot dispatch an Agent')
  // Cold API observation does not select a renderer workspace. Reopen the
  // same synthetic conversation before the separate interactive policy case.
  await wait(() => evaluate(`Boolean(document.querySelector(${json(project)}))`), 'cold fixture project')
  if (await evaluate(`document.querySelector(${json(project)}).getAttribute('aria-expanded') !== 'true'`)) await click(project)
  await wait(() => evaluate(`Boolean(document.querySelector(${json(entry)}))`), 'persisted synthetic conversation')
  await click(entry)
  await wait(() => evaluate(`document.querySelector('.conversation-chat')?.dataset.conversationId === ${json(conversation.id)}`), 'policy conversation context')
  const policy = await exerciseParallelFailurePolicy({ workflow, evaluate, wait, click, cdp, workspace, userData, evidence, readInputs })
  assert.equal((await readInputs()).length, 4, 'the separate policy scenario adds exactly two offline actors')
  const sizePreferences = await exerciseWorkflowSizePreferences({ workflow, evaluate, wait, click, cdp, userData, evidence, readInputs })
  await stop()
  await launch()
  await verifyParallelFailurePolicyCold({ workflow, policy, userData })
  await verifyWorkflowSizePreferencesCold(workflow, sizePreferences)
  assert.equal((await readInputs()).length, 4, 'cold policy observation cannot replay an Agent or a stop command')
  result = { workflowId: id, programRevision: preview.programRevision, target: active.held.attemptId, commandId,
    stopped: selected.state, sibling: sibling.state, attempts: record.intents.length, budget: record.progress.dispatchAttempts,
    terminalState: final.state, trustedNativeClick: true, coldDuplicateNoRedispatch: true, offlineAdapterCalls: 4,
    realSdkOrAccount: 'unverified', frameInspection, executionInspection, native, nodeTests, policy, sizePreferences, hashes }
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), stderr, owned: inspectOwnedApp(child) }, null, 2))
  throw error
} finally {
  await stop()
  await writeFile(join(evidence, 'closure.json'), JSON.stringify(closures, null, 2))
  console.log('Workflow node stop App evidence: ' + evidence)
}
await writeFile(join(evidence, 'verification.json'), JSON.stringify({ ...result, closures }, null, 2))
console.log(JSON.stringify({ ...result, closures, evidence }))
