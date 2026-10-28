import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Actual trusted preload/Main reads against the retained synthetic workspace.
 * Receipt-state injection is not a filesystem crash or a native SDK probe. */
export async function exerciseWorkflowTaskObservation(evaluate, fixture, proof) {
  const reference = proof.request.submission
  const beforeCalls = readFileSync(fixture.callsFile)
  const files = [proof.taskFile, proof.file, proof.rootFile, proof.outputFile, proof.inputFile]
  const before = files.map(file => ({ file, bytes: readFileSync(file) }))
  const list = await evaluate(`window.scry.workflow.capturedTasks(${JSON.stringify(reference.conversationId)})`)
  assert.equal(list.items.length, 1)
  assert.deepEqual(list.items[0].reference, reference)
  assert.equal(list.items[0].phase, 'unknown')
  assert.equal(list.items[0].workflowId, proof.workflowId)
  assert.equal(JSON.stringify(list).includes('authoringContinuationKey'), false)
  const expression = `window.scry.workflow.inspectTask(${JSON.stringify(reference)})`
  const observed = await evaluate(expression)
  assert.equal(observed.outcome.kind, 'preview')
  assert.equal(observed.outcome.preview.workflowId, proof.workflowId)
  assert.equal(observed.task.phase, 'unknown', 'a known candidate must not reopen task dispatch')
  assert.equal(observed.command, proof.request.command)
  assert.deepEqual(observed.submission.reference, reference)
  assert.equal(observed.submission.planningCommandId, proof.request.commandId)
  assert.equal(observed.submission.size.snapshot.value, 'medium')
  assert.equal(observed.outcome.progressState, 'awaiting_approval')
  assert.equal(JSON.stringify(observed).includes('authoringContinuationKey'), false)
  const malformed = await evaluate(`window.scry.workflow.inspectTask(${JSON.stringify({ ...reference, cwd: fixture.otherCwd })}).then(() => false, () => true)`)
  assert.equal(malformed, true, 'renderer workspace must not become read authority')
  const intentBytes = readFileSync(proof.file)
  try {
    const unsettled = JSON.parse(intentBytes)
    unsettled.scopeSettled = false
    writeFileSync(proof.file, JSON.stringify(unsettled))
    const blocked = await evaluate(expression)
    assert.deepEqual(blocked.outcome, { kind: 'blocked', reason: 'unknown' })
  } finally { writeFileSync(proof.file, intentBytes) }
  for (const { file, bytes } of before) assert.deepEqual(readFileSync(file), bytes, 'read-only task observation mutated canonical evidence')
  assert.deepEqual(readFileSync(fixture.callsFile), beforeCalls, 'task observation reached a Provider')
  const result = { taskRows: list.items.length, rawCommandPreserved: true, knownPreviewWithoutReplanning: true,
    unknownFenceUnchanged: true, unsettledScopeNotExposed: true, rendererWorkspaceRejected: true,
    additionalProviderCalls: 0, evidence: before.map(({ file, bytes }) => ({ file, sha256: digest(bytes) })) }
  writeFileSync(join(fixture.userData, 'workflow-task-observation-proof.json'), JSON.stringify(result, null, 2))
  return result
}
