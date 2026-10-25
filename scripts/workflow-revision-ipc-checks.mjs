import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export async function readWorkflowRevisionRecord(fixture) {
  const id = fixture.workflowRevision.workflowId, directory = join(fixture.userData, 'workflows')
  const record = JSON.parse(await readFile(join(directory, id + '.json'), 'utf8'))
  if (record.revisions) record.revisions = await Promise.all(record.revisions.map(async entry => {
    assert.match(entry.reference, new RegExp('^' + id + '\\.[a-f0-9]{64}\\.governing\\.json$'))
    const text = await readFile(join(directory, entry.reference), 'utf8')
    assert.equal(entry.reference, id + '.' + createHash('sha256').update(text).digest('hex') + '.governing.json')
    return JSON.parse(text)
  }))
  return record
}

/** Production preload/main compiler and Host; only a fixed local Node check.
 * The source and replicas belong to the isolated Electron fixture. */
export async function exerciseWorkflowRevisions(evaluate, fixture) {
  const workflow = (method, ...args) => evaluate(`window.scry.workflow.${method}(...${JSON.stringify(args)})`)
  const script = 'scry-revision-check.cjs', marker = 'scry-revision-check-count'
  await writeFile(join(fixture.workspace, script), `const fs = require('node:fs'); let count = 0; try { count = Number(fs.readFileSync(${JSON.stringify(marker)}, 'utf8')) } catch(e) { if(e.code !== 'ENOENT') throw e } fs.writeFileSync(${JSON.stringify(marker)}, String(count + 1)); console.log('REVISION-CHECK-OBSERVED')`)
  const definition = { schemaVersion: 1, name: 'Native revision source', description: '', parameters: {}, roles: [], body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'replica', blockId: 'copy' },
    { kind: 'check', blockId: 'check', replica: { kind: 'ref', name: 'copy' }, check: { argv: [process.execPath, script], cwd: '.', timeoutMs: 2000, parser: 'exit_code' } },
    { kind: 'return', blockId: 'report', ref: { nodeId: 'check', path: ['passed'] } }
  ] } }
  const saved = await evaluate(`window.scry.workflow.templates.saveDraft(${JSON.stringify({ scope: { kind: 'personal' }, source: JSON.stringify(definition) })})`)
  assert.equal(saved.validation.state, 'valid')
  const original = await workflow('instantiateTemplate', { source: { kind: 'draft', draftId: saved.draftId, draftRevision: saved.draftRevision, candidateHash: saved.candidateHash },
    commandId: 'revision-source-instance', cwd: fixture.workspace, userGoal: 'Observe durable same-root revision', parameters: {}, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [] })
  assert.equal(original.state, 'ready', JSON.stringify(original.unavailableReasons))
  const firstApproval = { workflowId: original.workflowId, programRevision: original.programRevision, approvedAt: 1 }
  await workflow('approve', firstApproval)
  const first = await workflow('start', original.workflowId, firstApproval, 'revision-source-start')
  assert.equal(first.state, 'completed', JSON.stringify(first))
  fixture.workflowRevision = { workflowId: original.workflowId, marker }
  const before = await readWorkflowRevisionRecord(fixture)
  const body = structuredClone(original.program.body)
  body.blocks.at(-1).blockId = 'revised_report'
  const check = body.blocks.find(block => block.kind === 'check')
  check.authorization.executableHash = '0'.repeat(64)
  check.authorization.launch.args = ['-e', 'throw new Error("forged launch")']
  const source = { workflowId: original.workflowId, expectedRevision: first.revision, userGoal: original.userGoal,
    roles: original.program.roles.map(({ runtimeIdentity, ...role }) => role), body }
  await assert.rejects(workflow('prepareRevision', { ...source, workspace: '/unapproved' }))
  await assert.rejects(workflow('prepareRevision', { ...source, roles: [{ ...source.roles[0], runtimeIdentity: 'forged' }] }))
  const candidate = await workflow('prepareRevision', source)
  assert.equal(candidate.workspace, original.workspace)
  assert.equal(candidate.state, 'ready', JSON.stringify(candidate.unavailableReasons))
  assert.notEqual(candidate.programRevision, original.programRevision)
  assert.equal(candidate.program.template, undefined, 'editing a run must not claim the original frozen template body')
  const frozen = candidate.program.body.blocks.find(block => block.kind === 'check').authorization
  assert.notEqual(frozen.executableHash, check.authorization.executableHash)
  assert.notDeepEqual(frozen.launch.args, check.authorization.launch.args)
  assert.deepEqual(await readWorkflowRevisionRecord(fixture), before, 'preparation must not claim, execute or rewrite root history')
  const approval = { workflowId: candidate.workflowId, programRevision: candidate.programRevision, approvedAt: 2 }
  const target = { expectedRevision: first.revision }, commandId = 'reviewed-native-revision'
  await assert.rejects(workflow('revise', candidate.workflowId, { ...approval, programRevision: 'unprepared-digest' }, target, 'unprepared-command'))
  await assert.rejects(workflow('revise', candidate.workflowId, approval, { expectedRevision: first.revision + 1 }, 'stale-command'))
  const result = await workflow('revise', candidate.workflowId, approval, target, commandId)
  assert.equal(result.state, 'completed', JSON.stringify(result))
  assert.equal(result.workflowId, first.workflowId)
  assert.equal(result.finalReport, 'true')
  assert.equal(result.dispatchAttempts, 0)
  const record = await readWorkflowRevisionRecord(fixture)
  assert.equal(record.revisions.length, 2)
  assert.equal(record.execution.segments.length, 2)
  assert.deepEqual(record.systemOutcomes.slice(0, 2), before.systemOutcomes)
  assert.equal(record.systemIntents.length, 4)
  assert.equal(record.systemOutcomes.length, 4)
  assert.ok(record.systemOutcomes.every(outcome => outcome.settled && outcome.state === 'completed'))
  assert.ok(record.revisions[0].preview.program.template)
  assert.equal(record.preview.program.template, undefined)
  fixture.workflowRevision = { ...fixture.workflowRevision, approval, target, commandId }
  await assertWorkflowRevisionCopies(fixture, record, 2)
  assert.deepEqual(await workflow('revise', candidate.workflowId, approval, target, commandId), result)
  assert.deepEqual(await readWorkflowRevisionRecord(fixture), record)
  return { test: 'main-prepared revision production IPC', noDispatchDuringPreparation: true, mainRefrozeNativeAuthorization: true,
    sameRoot: true, retainedTemplateHistory: true, detachedEditedRun: true, freshNativeSteps: 2, durableDuplicateNoDispatch: true, agentAttempts: 0 }
}

export async function assertWorkflowRevisionCopies(fixture, record, expected) {
  const preparations = new Set(record.systemIntents.filter(intent => intent.kind === 'prepare_replica').map(intent => intent.stepId))
  const copies = record.systemOutcomes.filter(outcome => preparations.has(outcome.stepId))
  assert.equal(copies.length, expected)
  assert.equal(new Set(copies.map(outcome => outcome.replica.replicaId)).size, expected)
  for (const outcome of copies) {
    const receipt = JSON.parse(await readFile(join(fixture.userData, 'workflow-replicas', record.preview.workflowId, outcome.replica.replicaId + '.replica.json'), 'utf8'))
    assert.equal(await readFile(join(receipt.directory, fixture.workflowRevision.marker), 'utf8'), '1', 'each fresh owned copy runs its check only once')
  }
  await assert.rejects(readFile(join(fixture.workspace, fixture.workflowRevision.marker)), { code: 'ENOENT' })
}

export async function verifyWorkflowRevisionRestart(evaluate, fixture) {
  const accepted = fixture.workflowRevision, before = await readWorkflowRevisionRecord(fixture)
  const result = await evaluate(`window.scry.workflow.revise(...${JSON.stringify([accepted.workflowId, accepted.approval, accepted.target, accepted.commandId])})`)
  assert.equal(result.programRevision, before.preview.programRevision)
  assert.equal(result.state, 'completed')
  assert.deepEqual(await readWorkflowRevisionRecord(fixture), before, 'cold accepted-command replay must not rewrite history')
  await assertWorkflowRevisionCopies(fixture, before, before.systemIntents.filter(intent => intent.kind === 'prepare_replica').length)
  return { coldAcceptedRevisionNoDispatch: true, canonicalHistoryUnchanged: true }
}
