import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Real App/main/preload/FileStore policy acceptance, with two additional
 * explicitly offline held actors. No Provider SDK/account or native command. */
export async function exerciseParallelFailurePolicy({ workflow, evaluate, wait, click, cdp, workspace, userData, evidence, readInputs }) {
  const definition = { schemaVersion: 1, templateId: 'parallel-policy-app-fixture', name: 'Isolated parallel policy fixture', description: 'Offline policy acceptance only',
    parameters: {}, roles: [{ role: 'worker', providerId: 'codex' }],
    body: { kind: 'sequence', blockId: 'policy_root', blocks: [
      { kind: 'parallel', blockId: 'policy_group', failurePolicy: 'fail_fast', blocks: [
        { kind: 'call', blockId: 'trigger', role: 'worker', prompt: 'native composer stop-immediate policy-trigger' },
        { kind: 'call', blockId: 'held', role: 'worker', prompt: 'native composer stop-immediate policy-held' }
      ] },
      { kind: 'return', blockId: 'policy_report', ref: { nodeId: 'policy_group' } }
    ] } }
  const draftInput = { scope: { kind: 'personal' }, source: JSON.stringify(definition) }
  const draft = await evaluate(`window.scry.workflow.templates.saveDraft(${JSON.stringify(draftInput)})`)
  assert.equal(draft.validation.state, 'valid', JSON.stringify(draft.validation))
  const preview = await workflow('instantiateTemplate', {
    source: { kind: 'draft', draftId: draft.draftId, draftRevision: draft.draftRevision, candidateHash: draft.candidateHash },
    commandId: 'parallel-policy-app-instance', cwd: workspace, userGoal: 'Apply the approved local parallel policy', parameters: {},
    orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [{ role: 'worker', providerId: 'codex' }]
  })
  assert.equal(preview.state, 'ready', JSON.stringify(preview.unavailableReasons))
  assert.equal(preview.program.body.blocks[0].failurePolicy, 'fail_fast')
  const id = preview.workflowId
  const approval = { workflowId: id, programRevision: preview.programRevision, approvedAt: Date.now() }
  assert.equal(await workflow('approve', approval), true)
  await evaluate(`window.__policyRun = window.scry.workflow.start(${JSON.stringify(id)}, ${JSON.stringify(approval)}, 'parallel-policy-app-start').then(value => { window.__policyFinal = value }, error => { window.__policyError = String(error) }); true`)
  const active = await wait(async () => {
    if (await evaluate('window.__policyError')) throw new Error(await evaluate('window.__policyError'))
    const progress = await workflow('snapshot', id)
    const trigger = progress?.attempts.find(attempt => attempt.nodeId === 'trigger')
    const held = progress?.attempts.find(attempt => attempt.nodeId === 'held')
    const calls = (await readInputs()).filter(input => input.prompt.startsWith('native composer stop-immediate policy-'))
    return trigger && held && !trigger.settled && !held.settled && calls.length === 2 ? { progress, trigger, held } : false
  }, 'both policy actors actually started before the user stops the trigger')
  assert.equal(active.progress.dispatchAttempts, 2)
  const card = `[data-workflow-id=${JSON.stringify(id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(card)}))`), 'policy workflow card')
  if (!await evaluate(`document.querySelector(${JSON.stringify(card)}).open`)) await click(card + ' summary')
  await click(card + ` [data-workflow-target=${JSON.stringify(active.trigger.attemptId)}]`)
  const final = await wait(async () => {
    if (await evaluate('window.__policyError')) throw new Error(await evaluate('window.__policyError'))
    const progress = await workflow('snapshot', id)
    const businessFinished = await evaluate('Boolean(window.__policyFinal)')
    return businessFinished && progress?.state !== 'running' && progress?.attempts.length === 2 && progress.attempts.every(attempt => attempt.settled) && progress.slots.inUse === 0 ? progress : false
  }, 'user-stopped trigger and automatically stopped sibling physically converge')
  assert.notEqual(final.state, 'completed')
  assert.equal(final.stopRequestedAt, undefined, 'a scoped policy is not a root stop')
  assert.equal(final.dispatchAttempts, 2)
  const recordPath = join(userData, 'workflows', id + '.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  const automatic = record.stopRequests.filter(request => request.provenance?.source === 'auto')
  const user = record.stopRequests.filter(request => !request.provenance)
  assert.equal(user.length, 1)
  assert.deepEqual(user[0].target, { kind: 'attempt', id: active.trigger.attemptId })
  assert.equal(automatic.length, 2, 'scope decision and the one remaining admitted target')
  const scoped = automatic.find(request => !request.target)
  const targeted = automatic.find(request => request.target)
  assert.ok(scoped)
  assert.deepEqual(targeted.target, { kind: 'attempt', id: active.held.attemptId })
  assert.deepEqual(scoped.provenance, targeted.provenance)
  assert.equal(targeted.provenance.policy, 'fail_fast')
  assert.equal(targeted.provenance.trigger.nodeId, 'trigger')
  // A targeted stop does not stop the root controller. Existing interpreter
  // semantics label its settled non-completed child as failed; the independent
  // canonical Provider outcome below must still retain state: stopped.
  assert.equal(targeted.provenance.trigger.phase, 'failed')
  const triggerFrame = await workflow('inspectFrame', id, active.trigger.frameId)
  assert.equal(triggerFrame.state, 'available')
  assert.equal(triggerFrame.frame.phase, 'failed')
  assert.deepEqual(triggerFrame.frame.parentage, { state: 'available', frameId: targeted.provenance.trigger.frameId })
  assert.equal(record.intents.length, 2)
  assert.equal(record.execution.segments.length, 1)
  assert.ok(record.outcomes.every(outcome => outcome.state === 'stopped' && outcome.settled === true))
  assert.ok(record.outcomes.every(outcome => !Object.hasOwn(outcome, 'stopRequested')))
  const heldRow = card + ` [data-workflow-target=${JSON.stringify(active.held.attemptId)}]`
  await wait(() => evaluate(`document.querySelector(${JSON.stringify(heldRow)})?.getAttribute('aria-disabled') === 'true'`), 'settled automatic row is not an active user control')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(heldRow)}).closest('.workflow-node-stop').textContent.includes('策略自动请求停止，触发节点：trigger')`), true)
  await assert.rejects(() => workflow('stopNode', id, targeted.target, targeted.commandId))
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')).stopRequests, record.stopRequests, 'user API cannot reinterpret the policy receipt')
  const view = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, 'parallel-policy.png'), Buffer.from(view.data, 'base64'))
  await writeFile(join(evidence, 'parallel-policy.json'), JSON.stringify({ record, final }, null, 2))
  return { workflowId: id, programRevision: preview.programRevision, targeted, user: user[0], stopRequests: record.stopRequests,
    offlineCalls: 2, dispatchAttempts: final.dispatchAttempts, actualUserStopTriggersPolicy: true, automaticSourceVisible: true }
}

export async function verifyParallelFailurePolicyCold({ workflow, policy, userData }) {
  const snapshot = await workflow('snapshot', policy.workflowId)
  assert.equal(snapshot.dispatchAttempts, policy.dispatchAttempts)
  assert.equal(snapshot.stopRequestedAt, undefined)
  const target = snapshot.attempts.find(attempt => attempt.attemptId === policy.targeted.target.id)
  assert.deepEqual(target.stopRequested.provenance, policy.targeted.provenance)
  assert.equal(target.stopRequested.commandId, policy.targeted.commandId)
  await assert.rejects(() => workflow('stopNode', policy.workflowId, policy.targeted.target, policy.targeted.commandId))
  assert.equal(await workflow('stopNode', policy.workflowId, policy.user.target, policy.user.commandId), true)
  const record = JSON.parse(await readFile(join(userData, 'workflows', policy.workflowId + '.json'), 'utf8'))
  assert.deepEqual(record.stopRequests, policy.stopRequests)
  assert.equal(record.intents.length, 2)
}
