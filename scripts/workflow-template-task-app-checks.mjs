import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyBody } from './desktop-task-app-checks.mjs'

const json = path => JSON.parse(readFileSync(path, 'utf8'))

/** Production preload/Main/Service/Interpreter, offline data-only template.
 * No Provider entry is required or authorized by this workload. */
export async function exerciseWorkflowTemplateTask(evaluate, fixture) {
  const workflow = (method, ...args) => evaluate(`window.scry.workflow.${method}(...${JSON.stringify(args)})`)
  const templates = (method, ...args) => evaluate(`window.scry.workflow.templates.${method}(...${JSON.stringify(args)})`)
  const before = readFileSync(fixture.callsFile)
  const conversation = await evaluate(`window.scry.conversations.create(${JSON.stringify(fixture.cwd)})`)
  const definition = { schemaVersion: 1, name: 'Captured fixed template', description: '', roles: [],
    parameters: { message: { schema: { type: 'string' }, default: 'not the requested value' } },
    body: { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'bind', blockId: 'answer', value: { kind: 'ref', name: 'message' } },
      { kind: 'return', blockId: 'finish', ref: { nodeId: 'answer' } }
    ] } }
  const draft = await templates('saveDraft', { scope: { kind: 'personal' }, source: JSON.stringify(definition) })
  assert.equal(draft.validation.state, 'valid')
  assert.equal((await templates('publish', { draftId: draft.draftId, draftRevision: draft.draftRevision,
    candidateHash: draft.candidateHash, commandId: 'captured-template-publish' })).state, 'published')
  const source = await templates('read', { kind: 'personal' }, draft.templateId)
  const prompt = `  /scry-workflow template personal:${draft.templateId} {"message":"<immutable parameter>"}  \n`
  const request = { conversationId: conversation.id, expectedRevision: conversation.revision,
    commandId: randomUUID(), prompt, selectedCommandId: 'scry:workflow' }
  const control = await evaluate(`window.scry.conversations.submit(${JSON.stringify(request)})`)
  assert.equal(control.action, 'open_workflow_template', JSON.stringify(control))
  assert.equal(control.command, prompt)
  assert.equal(control.submission.template.state, 'available')
  assert.deepEqual(control.submission.template.ref, source.ref)
  assert.deepEqual(control.submission.template.roles, ['orchestrator'])
  const body = verifyBody(fixture, request, 2)
  assert.equal(body.task.snapshot.operation, 'workflow_template')
  assert.deepEqual(body.task.snapshot.template, source.ref)
  assert.equal(body.task.state.kind, 'captured')
  assert.equal(body.task.snapshot.target, undefined)
  assert.equal(body.task.snapshot.nativeContext, undefined)
  assert.equal(json(body.content).command.operation, 'template')
  const preparation = { reference: control.submission.reference, orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [] }
  // Delete only the mutable personal source. Intake already owns the exact
  // App-retained revision, so preparation must not re-resolve a bare ID.
  assert.equal((await templates('delete', { ref: source.ref, commandId: 'captured-template-delete' })).state, 'deleted')
  assert.equal(await templates('read', { kind: 'personal' }, draft.templateId), null)
  const preview = await workflow('prepareTemplateTask', preparation)
  assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
  assert.equal(preview.userGoal, prompt.trim())
  assert.equal(preview.program.template.commandId, control.submission.instanceCommandId)
  assert.deepEqual(preview.program.template.origin, { kind: 'saved', ref: source.ref })
  assert.deepEqual(preview.program.template.ref, source.ref)
  const rootFile = join(fixture.userData, 'workflows', `${preview.workflowId}.json`)
  const root = json(rootFile)
  assert.equal(root.progress.state, 'awaiting_approval')
  assert.equal(root.progress.dispatchAttempts, 0)
  assert.equal(root.execution, undefined)
  assert.equal(root.planningRequestHash, undefined, 'fixed templates must not fabricate model-planning provenance')
  const bytes = readFileSync(rootFile)
  assert.deepEqual(await workflow('prepareTemplateTask', preparation), preview)
  assert.deepEqual(readFileSync(rootFile), bytes, 'duplicate preparation must only observe canonical state')
  assert.deepEqual(readFileSync(body.content), Buffer.from(JSON.stringify(json(body.content))), 'captured input is immutable canonical JSON')
  const observed = await workflow('inspectTask', control.submission.reference)
  assert.equal(observed.outcome.kind, 'preview')
  assert.equal(observed.outcome.progressState, 'awaiting_approval')
  assert.equal(observed.command, prompt)
  assert.deepEqual(observed.submission.template.ref, source.ref)
  assert.deepEqual(readFileSync(fixture.callsFile), before, 'intake/preparation/observation must not enter a Provider')
  const approval = { workflowId: preview.workflowId, programRevision: preview.programRevision, approvedAt: Date.now() }
  assert.equal(await workflow('approve', approval), true)
  const completed = await workflow('start', preview.workflowId, approval, 'captured-template-explicit-start')
  assert.equal(completed.state, 'completed')
  assert.equal(completed.finalReport, '<immutable parameter>', 'the Interpreter must execute the sealed parameter, not a canned result/default')
  assert.equal(completed.dispatchAttempts, 0)
  assert.deepEqual(readFileSync(fixture.callsFile), before, 'data-only execution must not enter a Provider')
  const proof = { request, preparation, source: source.ref, workflowId: preview.workflowId,
    programRevision: preview.programRevision, rootFile, inputFile: body.content,
    zeroProviderEntries: true, frozenSourceAfterDeletion: true, exactApproval: true, parameterExecuted: true }
  writeFileSync(join(fixture.userData, 'workflow-template-task-proof.json'), JSON.stringify(proof, null, 2))
  return proof
}

export async function verifyWorkflowTemplateTaskCold(evaluate, fixture, proof) {
  const before = readFileSync(fixture.callsFile)
  const files = [proof.rootFile, proof.inputFile]
  const bytes = files.map(file => readFileSync(file))
  const observed = await evaluate(`window.scry.workflow.inspectTask(${JSON.stringify(proof.preparation.reference)})`)
  assert.equal(observed.outcome.kind, 'preview')
  assert.equal(observed.outcome.progressState, 'completed')
  assert.equal(observed.command, proof.request.prompt)
  assert.equal(observed.outcome.preview.programRevision, proof.programRevision)
  assert.deepEqual(observed.submission.template.ref, proof.source)
  const preview = await evaluate(`window.scry.workflow.prepareTemplateTask(${JSON.stringify(proof.preparation)})`)
  assert.equal(preview.workflowId, proof.workflowId)
  assert.equal(preview.programRevision, proof.programRevision)
  files.forEach((file, index) => assert.deepEqual(readFileSync(file), bytes[index], 'cold observation changed a canonical file'))
  assert.deepEqual(readFileSync(fixture.callsFile), before, 'cold template observation replayed a Provider')
  return { canonicalCompletedInstanceObserved: true, noPreparationReplay: true, canonicalBytesUnchanged: true }
}
