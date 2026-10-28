import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const files = ['tap-pass.test.cjs', 'tap-skip.test.cjs']
const ran = 'tap-body-ran', skipped = 'tap-skipped-body-ran'
const hash = value => createHash('sha256').update(value).digest('hex')
const counts = { total: 2, suites: 0, passed: 1, failed: 0, cancelled: 0, skipped: 1, todo: 0 }

export async function writeNodeTestAppFixtures(workspace) {
  await writeFile(join(workspace, files[0]), `const { test } = require('node:test')
const fs = require('node:fs')
test('actual body', () => {
  let count = 0
  try { count = Number(fs.readFileSync(${JSON.stringify(ran)}, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  fs.writeFileSync(${JSON.stringify(ran)}, String(count + 1))
})
`)
  await writeFile(join(workspace, files[1]), `const { test } = require('node:test')
const fs = require('node:fs')
test.skip('unexecuted body', () => fs.writeFileSync(${JSON.stringify(skipped)}, '1'))
`)
}

export async function exerciseNodeTestAppEvidence({ workflow, evaluate, wait, click, workspace, userData, evidence }) {
  const definition = { schemaVersion: 1, name: 'Bounded Node TAP evidence acceptance', description: '', parameters: {}, roles: [],
    body: { kind: 'sequence', blockId: 'tap_root', blocks: [
      { kind: 'replica', blockId: 'tap_copy' },
      { kind: 'check', blockId: 'native_node_tests', replica: { kind: 'ref', name: 'tap_copy' },
        check: { argv: [process.execPath, '--test', '--test-reporter=tap', ...files], cwd: '.', timeoutMs: 5000, parser: 'node_test' } },
      { kind: 'return', blockId: 'tap_report', ref: { nodeId: 'native_node_tests', path: ['passed'] } }
    ] } }
  const draft = await evaluate(`window.scry.workflow.templates.saveDraft(${JSON.stringify({ scope: { kind: 'personal' }, source: JSON.stringify(definition) })})`)
  assert.equal(draft.validation.state, 'valid', JSON.stringify(draft.validation))
  const preview = await workflow('instantiateTemplate', {
    source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash },
    commandId: 'node-test-evidence-instance', cwd: workspace, userGoal: 'Observe bounded runner evidence', parameters: {},
    orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: []
  })
  assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
  assert.equal(preview.plannedCalls, 0)
  const frozen = preview.program.body.blocks[1].authorization
  assert.equal(frozen.testFiles.length, 2)
  for (const [index, file] of files.entries()) assert.equal(frozen.testFiles[index].hash, hash(await readFile(join(workspace, file))))
  const id = preview.workflowId
  const approval = { workflowId: id, programRevision: preview.programRevision, approvedAt: 1 }
  await workflow('approve', approval)
  const progress = await workflow('start', id, approval, 'node-test-evidence-start')
  assert.equal(progress.state, 'completed')
  assert.equal(progress.finalReport, 'false', 'a skipped Node test cannot become a passing required check')
  assert.equal(progress.dispatchAttempts, 0)
  const step = progress.systemSteps.find(item => item.nodeId === 'native_node_tests')
  assert.equal(step.result.state, 'incomplete')
  assert.equal(step.result.exitCode, 0)
  assert.equal(step.settled, true)
  assert.equal(step.result.tests.state, 'available')
  assert.equal(step.result.tests.source, 'node_test_tap')
  assert.deepEqual(step.result.tests.counts, counts)
  for (const scope of ['discovery', 'execution', 'coverage']) {
    assert.equal(step.result.tests[scope].state, 'unavailable')
    assert.ok(step.result.tests[scope].reason.length > 0)
  }
  const record = JSON.parse(await readFile(join(userData, 'workflows', id + '.json'), 'utf8'))
  assert.equal(record.intents.length, 0)
  assert.equal(record.systemIntents.length, 2)
  const native = record.systemOutcomes.find(item => item.stepId === step.stepId)
  const reference = native.resultRef
  const contents = await readFile(join(userData, 'workflows', reference.workflowId + '.' + hash(reference.key) + '.' + reference.hash + '.value.json'), 'utf8')
  assert.equal(hash(contents), reference.hash)
  const value = JSON.parse(contents)
  assert.equal(value.state, 'known')
  assert.equal(value.value.passed, false)
  assert.equal(value.value.state, 'incomplete')
  assert.deepEqual(value.value.tests, step.result.tests)
  const replica = record.systemIntents.find(item => item.stepId === step.stepId).replica
  const receipt = JSON.parse(await readFile(join(userData, 'workflow-replicas', id, replica.replicaId + '.replica.json'), 'utf8'))
  const markerPath = join(receipt.directory, ran)
  assert.equal(await readFile(markerPath, 'utf8'), '1')
  await assert.rejects(readFile(join(receipt.directory, skipped)), { code: 'ENOENT' })
  for (const marker of [ran, skipped]) await assert.rejects(readFile(join(workspace, marker)), { code: 'ENOENT' })
  for (const [index, file] of files.entries()) assert.equal(hash(await readFile(join(workspace, file))), frozen.testFiles[index].hash)
  const card = `[data-workflow-id=${JSON.stringify(id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(card)}))`), 'Node TAP evidence root card')
  if (!await evaluate(`document.querySelector(${JSON.stringify(card)}).open`)) await click(card + ' summary')
  const row = card + ' [data-workflow-system-step="native_node_tests"]'
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row)}).textContent.includes('证据不完整')`), true)
  const result = { workflowId: id, approval, startCommandId: 'node-test-evidence-start', markerPath,
    recordPath: join(userData, 'workflows', id + '.json'), intentsHash: hash(JSON.stringify(record.systemIntents)),
    runnerCounts: counts, check: 'incomplete', passed: false, agentAttempts: 0,
    discovery: 'unavailable', execution: 'unavailable', coverage: 'unavailable',
    fixtureBodyRan: true, skippedBodyDidNotRun: true, sourceUnchanged: true }
  await writeFile(join(evidence, 'node-test-evidence.json'), JSON.stringify(result, null, 2))
  return result
}

export async function verifyNodeTestAppEvidenceCold(workflow, result) {
  const progress = await workflow('start', result.workflowId, result.approval, result.startCommandId)
  const step = progress.systemSteps.find(item => item.nodeId === 'native_node_tests')
  assert.equal(step.result.state, 'incomplete')
  assert.deepEqual(step.result.tests.counts, result.runnerCounts)
  assert.equal(progress.finalReport, 'false')
  assert.equal(progress.dispatchAttempts, 0)
  assert.equal(await readFile(result.markerPath, 'utf8'), '1', 'cold receipt cannot rerun a test body')
  const record = JSON.parse(await readFile(result.recordPath, 'utf8'))
  assert.equal(hash(JSON.stringify(record.systemIntents)), result.intentsHash, 'cold receipt cannot replace or append native intents')
  assert.equal(record.execution.segments.length, 1)
}
