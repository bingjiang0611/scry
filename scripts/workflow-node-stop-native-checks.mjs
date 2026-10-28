import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const script = 'native-stop.cjs'
const marker = 'native-stop-ready.json'
const hash = value => createHash('sha256').update(value).digest('hex')

export async function writeNativeStopFixture(workspace) {
  // An FS watcher holds a real process without a timer, network listener or SDK.
  await writeFile(join(workspace, script), `const fs = require('node:fs')
const watcher = fs.watch('.', () => {})
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, parent: process.ppid }))
console.log('SCRY_NATIVE_ACTOR_READY')
`)
}

export async function exerciseNativeNodeStop({ workflow, evaluate, wait, click, workspace, userData, evidence }) {
  const definition = { schemaVersion: 1, name: 'Native node stop acceptance', description: '', parameters: {}, roles: [],
    body: { kind: 'sequence', blockId: 'native_root', blocks: [
      { kind: 'replica', blockId: 'owned_copy' },
      { kind: 'check', blockId: 'held_check', replica: { kind: 'ref', name: 'owned_copy' },
        check: { argv: [process.execPath, script], cwd: '.', timeoutMs: 10000, parser: 'exit_code' } },
      { kind: 'return', blockId: 'native_report', ref: { nodeId: 'held_check', path: ['passed'] } }
    ] } }
  const draft = await evaluate(`window.scry.workflow.templates.saveDraft(${JSON.stringify({ scope: { kind: 'personal' }, source: JSON.stringify(definition) })})`)
  assert.equal(draft.validation.state, 'valid', JSON.stringify(draft.validation))
  const preview = await workflow('instantiateTemplate', {
    source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash },
    commandId: 'native-node-stop-instance', cwd: workspace, userGoal: 'Stop one actual native process', parameters: {},
    orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: []
  })
  assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
  assert.equal(preview.plannedCalls, 0)
  const sourceHash = hash(await readFile(join(workspace, script)))
  assert.equal(preview.program.body.blocks[1].authorization.entrypoint.hash, sourceHash)
  await assert.rejects(readFile(join(workspace, marker)), { code: 'ENOENT' })
  const id = preview.workflowId
  const recordPath = join(userData, 'workflows', id + '.json')
  const approval = { workflowId: id, programRevision: preview.programRevision, approvedAt: 1 }
  await workflow('approve', approval)
  await evaluate(`window.__nativeStopFinal = null; window.__nativeStopError = null;
    window.scry.workflow.start(${JSON.stringify(id)}, ${JSON.stringify(approval)}, 'native-node-stop-start')
      .then(value => { window.__nativeStopFinal = value }).catch(error => { window.__nativeStopError = String(error) }); true`)
  const { active, reference } = await wait(async () => {
    const failure = await evaluate('window.__nativeStopError')
    assert.equal(failure, null)
    const progress = await workflow('snapshot', id)
    const active = progress.systemSteps?.find(step => step.nodeId === 'held_check' && step.state === 'running' && !step.settled)
    if (!active) return null
    // A live projection can precede its publisher. Observe the durable intent
    // separately; neither the row nor this receipt proves the actor has started.
    const admitted = JSON.parse(await readFile(recordPath, 'utf8'))
    const intent = admitted.systemIntents.find(intent => intent.stepId === active.stepId)
    return intent ? { active, reference: intent.replica } : null
  }, 'durable native check admission')
  const receiptPath = join(userData, 'workflow-replicas', id, reference.replicaId + '.replica.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const markerPath = join(receipt.directory, marker)
  const actor = await wait(async () => {
    try { return JSON.parse(await readFile(markerPath, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }, 'real native process ready marker')
  assert.ok(Number.isSafeInteger(actor.pid) && actor.pid > 0)
  process.kill(actor.pid, 0)
  const card = `[data-workflow-id=${JSON.stringify(id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(card)}))`), 'native root card')
  if (!await evaluate(`document.querySelector(${JSON.stringify(card)}).open`)) await click(card + ' summary')
  assert.equal(typeof active.frameId, 'string', 'The native admission must expose its actual execution frame')
  const metadata = await workflow('inspectFrame', id, active.frameId)
  assert.equal(metadata.state, 'available')
  assert.equal(metadata.frame.nodeId, active.nodeId)
  const inspect = card + ` [data-workflow-frame-open=${JSON.stringify(active.frameId)}]`
  await click(inspect)
  await wait(() => evaluate(`document.querySelector('.workflow-frame-inspector [data-workflow-frame]')?.getAttribute('data-workflow-frame') === ${JSON.stringify(active.frameId)}`), 'native frame metadata in production UI')
  await click('[data-workflow-frame-action="close"]')
  await wait(() => evaluate(`!document.querySelector('.workflow-frame-inspector')`), 'native inspector close')
  const target = card + ` [data-workflow-target=${JSON.stringify(active.stepId)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(target)}))`), 'native SystemStep stop action')
  await click(target)
  await wait(async () => {
    const failure = await evaluate('window.__nativeStopError')
    assert.equal(failure, null)
    return evaluate('window.__nativeStopFinal')
  }, 'actual native process and scope convergence')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  const outcome = record.systemOutcomes.find(item => item.stepId === active.stepId)
  assert.equal(outcome.state, 'stopped')
  assert.equal(outcome.settled, true)
  assert.equal(outcome.check.state, 'cancelled')
  assert.equal(outcome.check.signal, 'SIGKILL')
  assert.equal(outcome.check.exitCode, null)
  assert.throws(() => process.kill(actor.pid, 0), { code: 'ESRCH' })
  assert.equal(record.intents.length, 0)
  assert.equal(record.progress.dispatchAttempts, 0)
  assert.equal(record.systemIntents.length, 2)
  assert.equal(record.stopRequests.length, 1)
  assert.deepEqual(record.stopRequests[0].target, { kind: 'system', id: active.stepId })
  assert.ok(record.systemOutcomes.every(item => !Object.hasOwn(item, 'stopRequested')))
  const stdout = outcome.check.stdoutRef
  const contents = await readFile(join(userData, 'workflows', stdout.workflowId + '.' + hash(stdout.key) + '.' + stdout.hash + '.value.json'), 'utf8')
  assert.equal(hash(contents), stdout.hash)
  assert.match(JSON.parse(contents).value, /SCRY_NATIVE_ACTOR_READY/)
  await assert.rejects(readFile(join(workspace, marker)), { code: 'ENOENT' })
  assert.equal(hash(await readFile(join(workspace, script))), sourceHash)
  const commandId = record.stopRequests[0].commandId
  assert.equal(await workflow('stopNode', id, { kind: 'system', id: active.stepId }, commandId), true)
  const result = { workflowId: id, target: active.stepId, commandId, markerPath, marker: actor,
    nativeExecutions: 1, signal: outcome.check.signal, scopeSettled: true, processAbsent: true,
    sourceUnchanged: true, agentAttempts: 0 }
  await writeFile(join(evidence, 'native-stop.json'), JSON.stringify(result, null, 2))
  return result
}

export async function verifyNativeNodeStopCold(workflow, result) {
  assert.equal(await workflow('stopNode', result.workflowId, { kind: 'system', id: result.target }, result.commandId), true)
  const progress = await workflow('snapshot', result.workflowId)
  const step = progress.systemSteps.find(item => item.stepId === result.target)
  assert.equal(step.state, 'stopped')
  assert.equal(step.settled, true)
  assert.equal(step.stopRequested.commandId, result.commandId)
  assert.equal(progress.dispatchAttempts, 0)
  assert.deepEqual(JSON.parse(await readFile(result.markerPath, 'utf8')), result.marker, 'cold receipt cannot restart the native process')
  assert.throws(() => process.kill(result.marker.pid, 0), { code: 'ESRCH' })
}
