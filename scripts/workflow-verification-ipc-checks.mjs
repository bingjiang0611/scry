import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Frozen local Node cases, deliberately phase-dependent fixture diagnostics.
 * This proves canonical evidence consumption, not actual tsc or code progress. */
export async function exerciseWorkflowVerification(evaluate, fixture) {
  const templates = (method, ...args) => evaluate(`window.scry.workflow.templates.${method}(...${JSON.stringify(args)})`)
  const workflow = (method, ...args) => evaluate(`window.scry.workflow.${method}(...${JSON.stringify(args)})`)
  const calls = async () => {
    // The offline CLI creates its append-only call log at the first invocation.
    const text = await readFile(fixture.callsFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    return text.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.operation === 'run').length
  }
  const before = await calls(), script = 'scry-required-checks-fixture.cjs', marker = 'scry-required-checks-count'
  await writeFile(join(fixture.templateWorkspace, script), `
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const directory = ${JSON.stringify(join(fixture.userData, 'workflows'))}
let intent
for(const name of fs.readdirSync(directory)) {
  if(!/^workflow-[a-f0-9]{64}\\.json$/.test(name)) continue
  const record = JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'))
  intent = record.systemIntents?.find(item => /^required_(before|after)(types|tests)$/.test(item.nodeId) && !record.systemOutcomes?.some(outcome => outcome.stepId === item.stepId))
  if(intent) break
}
assert.equal(intent?.kind, 'check')
assert.equal(intent.inputMaterialization?.state, 'available')
assert.equal(intent.inputSnapshot.inputHash, intent.inputMaterialization.materialized.inputHash)
assert.equal(fs.existsSync(${JSON.stringify(marker)}), false, 'native check executed twice')
fs.writeFileSync(${JSON.stringify(marker)}, '1')
const after = intent.nodeId.includes('after')
if(process.argv[2] === 'types') { console.log('src/a.ts('+(after?9:2)+',3): error TS100: retained'); if(after) console.log('src/a.ts(10,3): error TS200: added'); process.exitCode=1 }
else if(after) { console.log('tests/a.ts(1,1): error TS300: test failed'); process.exitCode=1 }
`)
  const ref = name => ({ kind: 'ref', name })
  const checks = prefix => ['types', 'tests'].flatMap(key => [
    { kind: 'replica', blockId: prefix + key + 'copy', source: ref('required_candidate') },
    { kind: 'check', blockId: prefix + key, replica: ref(prefix + key + 'copy'), check: { argv: [process.execPath, script, key], cwd: '.', timeoutMs: 2000, parser: 'typescript' } }
  ])
  const required = prefix => Object.fromEntries(['types', 'tests'].map(key => [key, { check: prefix + key, result: ref(prefix + key) }]))
  const definition = { schemaVersion: 1, name: 'Required check comparison fixture', description: '', parameters: {}, roles: [], body: { kind: 'sequence', blockId: 'required_root', blocks: [
    { kind: 'replica', blockId: 'required_candidate' }, ...checks('required_before'),
    { kind: 'verification', blockId: 'required_baseline', required: required('required_before'), protectedPaths: [script] }, ...checks('required_after'),
    { kind: 'verification', blockId: 'required_current', required: required('required_after'), baseline: ref('required_baseline'), protectedPaths: [script] },
    { kind: 'return', blockId: 'required_report', ref: { nodeId: 'required_current' } }
  ] } }
  const draft = await templates('saveDraft', { scope: { kind: 'personal' }, source: JSON.stringify(definition) })
  assert.equal(draft.validation.state, 'valid', JSON.stringify(draft.validation))
  const preview = await workflow('instantiateTemplate', { source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash }, commandId: 'required-comparison-instance',
    cwd: fixture.templateWorkspace, userGoal: 'Compare frozen offline check observations without claiming trusted progress', parameters: {}, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [] })
  assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
  assert.equal(preview.plannedCalls, 0)
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: 1 }
  await workflow('approve', approval)
  const progress = await workflow('start', preview.workflowId, approval, 'required-comparison-start')
  assert.equal(progress.state, 'completed', JSON.stringify(progress))
  assert.equal(progress.dispatchAttempts, 0)
  const value = JSON.parse(progress.finalReport)
  assert.equal(value.state, 'available')
  assert.equal(value.passed, false)
  assert.equal(value.protectedSurface.state, 'available')
  assert.equal(value.protectedSurface.source, 'main_manifest')
  assert.deepEqual(value.protectedSurface.protectedPaths, [script])
  assert.equal(value.protectedSurface.entryCount, 1)
  assert.equal(value.protectedSurface.observations, 8)
  assert.equal(value.comparison.state, 'available')
  assert.deepEqual(value.comparison.regressedChecks, ['tests'])
  assert.deepEqual(value.comparison.recoveredChecks, [])
  assert.equal(value.comparison.diagnostics.state, 'available')
  assert.deepEqual(value.comparison.diagnostics.removed, [])
  assert.deepEqual(value.comparison.diagnostics.added.map(item => [item.check, item.code, item.count]), [['tests', 'TS300', 1], ['types', 'TS200', 1]])
  assert.equal(value.comparison.progress.state, 'unavailable', 'fixture deltas are not certified code progress')
  const record = JSON.parse(await readFile(join(fixture.userData, 'workflows', preview.workflowId + '.json'), 'utf8'))
  assert.equal(record.systemIntents.length, 11)
  const baselineCheck = record.systemIntents.find(item => item.stepId === value.protectedSurface.referenceStepId)
  assert.equal(baselineCheck.nodeId, 'required_beforetests')
  assert.equal(value.protectedSurface.referenceInputHash, baselineCheck.inputSnapshot.inputHash)
  assert.deepEqual(record.preview.program.body.blocks.find(item => item.blockId === 'required_current').protectedPaths, [script])
  assert.equal(record.systemIntents.filter(item => item.kind === 'verification').length, 2)
  assert.ok(record.systemOutcomes.every(item => item.settled))
  const own = record.systemIntents.find(item => item.nodeId === 'required_current')
  assert.deepEqual(Object.keys(own.verificationInputs.checks).sort(), ['tests', 'types'])
  assert.deepEqual(Object.values(own.verificationInputs.checks).sort(), value.checks.map(item => item.stepId).sort())
  for(const outcome of record.systemOutcomes.filter(item => item.check)) {
    const reference = outcome.replica
    const receipt = JSON.parse(await readFile(join(fixture.userData, 'workflow-replicas', preview.workflowId, reference.replicaId + '.replica.json'), 'utf8'))
    assert.equal(await readFile(join(receipt.directory, marker), 'utf8'), '1')
  }
  await assert.rejects(readFile(join(fixture.templateWorkspace, marker)), { code: 'ENOENT' })
  assert.equal((await workflow('start', preview.workflowId, approval, 'required-comparison-start')).finalReport, progress.finalReport)
  assert.equal(await calls(), before)
  return { requiredChecks: 2, verificationSteps: 2, nativeExecutions: 4, agentAttempts: 0, providerDelta: 0, retainedAfterLineShift: 'TS100', addedDiagnostics: ['TS300', 'TS200'], regressedChecks: ['tests'], protectedSurface: 'available', protectedObservations: 8, protectedPolicyFrozen: true, trustedProgress: 'unavailable', sourceUnchanged: true, repeatedStartReplayed: false }
}
