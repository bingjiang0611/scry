import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { publish, verifyBody } from './desktop-task-app-checks.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const rows = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const json = path => JSON.parse(readFileSync(path, 'utf8'))
function records(cwd) {
  const path = join(cwd, '.scry', 'records')
  return !existsSync(path) ? [] : readdirSync(path).sort().map(name => ({ name, sha256: digest(readFileSync(join(path, name))) }))
}

/** Actual production workflow IPC/executor with an explicitly synthetic result source.
 * No native SDK, account or model is invoked. This is not SDK enforcement proof. */
export async function exerciseWorkflowAuthoring(evaluate, fixture) {
  const candidate = { schemaVersion: 1, body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'call', blockId: 'worker', role: 'worker', prompt: 'This step must never execute before approval.' },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'worker' } }
  ] } }
  const candidateJson = JSON.stringify(candidate)
  const candidateFile = join(dirname(fixture.callsFile), 'workflow-authoring-candidate.json')
  writeFileSync(candidateFile, candidateJson)
  const beforeCalls = rows(fixture.callsFile)
  const beforeRecords = records(fixture.cwd)
  const binding = { providerId: 'codex', requestedModel: { id: 'workflow-fixture' }, permissionMode: 'default' }
  const conversation = await evaluate(`window.scry.conversations.create(${JSON.stringify(fixture.cwd)})`)
  const captureRequest = { conversationId: conversation.id, commandId: randomUUID(), expectedRevision: 0,
    prompt: '/scry-workflow run Produce one candidate without workspace effects', selectedCommandId: 'scry:workflow' }
  const control = await evaluate(`window.scry.conversations.submit(${JSON.stringify(captureRequest)})`)
  assert.equal(control.kind, 'control')
  assert.equal(control.action, 'open_workflow_planner')
  const taskProof = verifyBody(fixture, captureRequest, 2)
  assert.equal(taskProof.task.state.kind, 'captured')
  assert.equal('target' in taskProof.task.snapshot, false)
  assert.equal(control.submission.size.state, 'available')
  assert.equal(control.submission.size.snapshot.value, 'medium')
  assert.deepEqual(rows(fixture.callsFile), beforeCalls, 'capture invoked a Provider before planning consent')
  const request = { command: control.command, commandId: control.submission.planningCommandId, cwd: control.workspace,
    submission: control.submission.reference,
    orchestrator: { ...binding, role: 'orchestrator' }, roles: [{ ...binding, role: 'worker' }] }
  assert.equal(request.commandId, taskProof.task.submissionId)
  const changedSize = await evaluate(`window.scry.workflow.setSizeGuideline('small')`)
  assert.equal(changedSize.value, 'small')
  const expression = `window.scry.workflow.plan(${JSON.stringify(request)})`
  // Challenge the actual Main recorder gate, not a naturally recorder-disabled
  // workspace. Candidate-only authoring must not consult workspace recorder config.
  assert.equal(process.env.SCRY_RECORDER_ENABLED, '1')
  const recorderFile = join(fixture.cwd, 'scry.config.json')
  const originalConfig = existsSync(recorderFile) ? readFileSync(recorderFile) : undefined
  writeFileSync(recorderFile, 'null')
  let previews
  try { previews = await evaluate(`Promise.all([${expression}, ${expression}])`) }
  finally {
    if (originalConfig === undefined) unlinkSync(recorderFile)
    else writeFileSync(recorderFile, originalConfig)
    await evaluate(`window.scry.workflow.setSizeGuideline(null)`)
  }
  if (originalConfig === undefined) assert.equal(existsSync(recorderFile), false)
  else assert.deepEqual(readFileSync(recorderFile), originalConfig)
  const [preview, duplicate] = previews
  assert.equal(duplicate.workflowId, preview.workflowId)
  assert.equal(duplicate.programRevision, preview.programRevision)
  assert.deepEqual(preview.program.body, candidate.body, 'assistant text replaced the canonical structured result')
  assert.equal(preview.plannedCalls, 1)
  assert.deepEqual(preview.planningSize.snapshot, control.submission.size.snapshot, 'planning reread changed global size')
  const associatedTask = json(taskProof.file)
  assert.equal(associatedTask.state.kind, 'associated')
  assert.equal(associatedTask.state.branch, 'workflow')
  assert.equal(associatedTask.state.workflowId, preview.workflowId)
  assert.equal(associatedTask.state.programRevision, preview.programRevision)
  assert.deepEqual(associatedTask.snapshot, taskProof.task.snapshot)
  const progress = await evaluate(`window.scry.workflow.snapshot(${JSON.stringify(preview.workflowId)})`)
  assert.equal(progress.state, 'awaiting_approval')
  assert.equal(progress.dispatchAttempts, 0, 'planning must not execute the generated worker')
  const added = rows(fixture.callsFile).slice(beforeCalls.length)
  assert.deepEqual(added, [{ operation: 'run', identity: 'workflow-plan-' + preview.workflowId }], 'planning or duplicate input issued extra Provider calls')
  const input = rows(join(dirname(fixture.callsFile), 'desktop-task-provider-inputs.jsonl'))
    .find(row => row.runId === added[0].identity)
  assert.ok(input)
  assert.equal(input.purpose, 'workflow_authoring', 'Main did not forward its private purpose')
  assert.equal(input.managedRecorder, false, 'Main enabled a workspace recorder for candidate authoring')
  assert.equal(input.historyReaderEnabled, false)
  assert.equal(input.historicalContext, null)
  assert.equal(input.resume, null)
  assert.equal(input.permissionMode, 'default')
  assert.deepEqual(records(fixture.cwd), beforeRecords, 'planning modified canonical workspace records')
  const file = join(fixture.userData, 'workflows', preview.workflowId + '.planning.json')
  const intent = json(file)
  assert.equal(intent.status, 'completed')
  assert.equal(intent.scopeSettled, true)
  assert.equal(intent.result.outputSource, 'scry_fixture_success_result', 'synthetic provenance must never become SDK evidence')
  assert.ok(intent.result.archiveRef)
  assert.ok(intent.result.outputRef.startsWith(preview.workflowId + '.'))
  assert.equal(intent.result.outputRef, preview.workflowId + '.' + digest(candidateJson) + '.plan.txt')
  const outputFile = join(fixture.userData, 'workflows', intent.result.outputRef)
  assert.equal(readFileSync(outputFile, 'utf8'), candidateJson)
  const rootFile = join(fixture.userData, 'workflows', preview.workflowId + '.json')
  assert.equal(json(rootFile).planningRequestHash, digest(intent.fingerprint))
  assert.equal(associatedTask.state.planningRequestHash, json(rootFile).planningRequestHash)
  assert.equal(typeof associatedTask.state.authoringContinuationKey, 'string')
  assert.equal(input.expectedContinuationKey, associatedTask.state.authoringContinuationKey)
  assert.equal(JSON.parse(intent.fingerprint).capturedTask.authoringContinuationKey, input.expectedContinuationKey)
  assert.deepEqual(intent.sizeGuideline, control.submission.size.snapshot)
  const identityFence = await exerciseAuthoringIdentityFence(evaluate, fixture, request)
  const proof = { identityFence, workflowId: preview.workflowId, request, rootFile, plannedCalls: 1, dispatchedWorkers: 0,
    planningCallsIncludingDuplicate: 1, privatePurposeObserved: true, workspaceRecorderDisabled: true,
    capturedBeforePlanning: true, frozenMediumDespiteCurrentSmall: true,
    taskFile: taskProof.file, taskSha256: digest(readFileSync(taskProof.file)),
    inputFile: taskProof.content, inputSha256: taskProof.contentHash,
    workspaceRecordsUnchanged: true, invalidWorkspaceRecorderDidNotAffectAuthoring: true,
    recorderConfigurationRestored: true, noResumeOrHistory: true, canonicalCandidateNotAssistantText: true,
    source: intent.result.outputSource, file, sha256: digest(readFileSync(file)), outputFile, outputSha256: digest(candidateJson) }
  writeFileSync(join(fixture.userData, 'workflow-authoring-proof.json'), JSON.stringify(proof, null, 2))
  return proof
}

/** Hold the actual Main native-key recheck after its durable task claim. No
 * native executable or model is involved; the existing smoke adapter is used. */
async function exerciseAuthoringIdentityFence(evaluate, fixture, configured) {
  const conversation = await evaluate(`window.scry.conversations.create(${JSON.stringify(fixture.cwd)})`)
  const capture = { conversationId: conversation.id, commandId: randomUUID(), expectedRevision: 0,
    prompt: '/scry-workflow run Do not dispatch after the configured native scope changes', selectedCommandId: 'scry:workflow' }
  const control = await evaluate(`window.scry.conversations.submit(${JSON.stringify(capture)})`)
  assert.equal(control.kind, 'control')
  const task = verifyBody(fixture, capture, 2)
  const request = { ...configured, command: control.command, commandId: control.submission.planningCommandId,
    cwd: control.workspace, submission: control.submission.reference }
  const gateFile = join(fixture.userData, 'task-dispatch-gate.json')
  const marker = join(fixture.userData, 'task-dispatch-gate-entered.json')
  const oldGate = existsSync(gateFile) ? readFileSync(gateFile) : undefined
  const oldMarker = existsSync(marker) ? readFileSync(marker) : undefined
  const gate = { hold: true, cwd: control.workspace, conversationId: capture.conversationId, commandId: capture.commandId,
    workflowTaskId: control.submission.planningCommandId, identity: 'authoring-original' }
  const before = rows(fixture.callsFile).length
  if (existsSync(marker)) unlinkSync(marker)
  publish(gateFile, gate)
  let entered
  let watchError
  const observed = new Promise((resolve, reject) => { entered = resolve; watchError = reject })
  const changes = watch(fixture.userData, (_event, filename) => {
    if (filename === 'task-dispatch-gate-entered.json' && existsSync(marker)) entered({ kind: 'entered' })
  })
  changes.on('error', watchError)
  const attempt = evaluate(`window.scry.workflow.plan(${JSON.stringify(request)}).then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error) }))`)
  const evidenceFile = join(fixture.userData, 'workflow-authoring-identity-proof.json')
  // Match the existing task fixture's 15-second functional bound, without
  // polling or delaying dispatch. The owning launcher tears down on failure.
  let timer
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'deadline' }), 15_000) })
  try {
    const boundary = await Promise.race([observed, attempt.then(result => ({ kind: 'finished', result })), deadline])
    publish(evidenceFile, { boundary, expectedAdditionalProviderCalls: 0, actualAdditionalProviderCalls: rows(fixture.callsFile).length - before })
    assert.equal(boundary.kind, 'entered', 'planning finished without the Main native-identity recheck')
    assert.equal(json(marker).commandId, capture.commandId)
    assert.equal(json(task.file).state.kind, 'dispatch_intent')
    publish(gateFile, { ...gate, hold: false, identity: 'authoring-changed' })
    const result = await Promise.race([attempt, deadline])
    publish(evidenceFile, { boundary, result, expectedAdditionalProviderCalls: 0,
      actualAdditionalProviderCalls: rows(fixture.callsFile).length - before })
    assert.notEqual(result.kind, 'deadline', 'identity rejection did not settle within the task fixture deadline')
    assert.equal(result.ok, false, 'changed native scope still produced a candidate')
    assert.equal(rows(fixture.callsFile).length, before, 'changed native scope entered the actual smoke adapter')
    const fenced = json(task.file)
    assert.equal(fenced.state.kind, 'unknown')
    assert.ok(fenced.state.authoringContinuationKey.endsWith(':authoring-original'))
    const bytes = readFileSync(task.file)
    const duplicate = await Promise.race([evaluate(`window.scry.workflow.plan(${JSON.stringify(request)}).then(() => ({ ok: true }), error => ({ ok: false, error: String(error) }))`), deadline])
    assert.notEqual(duplicate.kind, 'deadline', 'identity rejection observation exceeded the task fixture deadline')
    assert.equal(duplicate.ok, false)
    assert.deepEqual(readFileSync(task.file), bytes, 'identity rejection reopened its task fence')
    assert.equal(rows(fixture.callsFile).length, before)
    const proof = { expectedAdditionalProviderCalls: 0, actualAdditionalProviderCalls: 0, mainIdentityGateObserved: true,
      changedIdentityRefused: true, unknownFenceByteUnchanged: true, taskFile: task.file, taskSha256: digest(bytes) }
    publish(evidenceFile, proof)
    return proof
  } finally {
    clearTimeout(timer)
    publish(gateFile, { ...gate, hold: false, identity: 'authoring-changed' })
    changes.close()
    // Do not await an unknown attempt again during failure cleanup. Its promise
    // already belongs to the race; the original owned-App finally stops it.
    if (oldGate === undefined) unlinkSync(gateFile)
    else writeFileSync(gateFile, oldGate)
    if (oldMarker === undefined) { if (existsSync(marker)) unlinkSync(marker) }
    else writeFileSync(marker, oldMarker)
  }
}

/** Controlled receipt-state injection after the unchanged cold checks above.
 * Real FileWorkflowStore write/ACK failures are exercised by the focused unit
 * tests; this fixture proves production IPC observes the root without a model. */
export async function exerciseWorkflowPlanningReceipt(evaluate, fixture, proof) {
  const callsBefore = readFileSync(fixture.callsFile)
  const rootBefore = readFileSync(proof.rootFile)
  const completedBefore = readFileSync(proof.file)
  assert.equal(digest(completedBefore), proof.sha256)
  const completedSnapshotFile = join(fixture.userData, 'workflow-authoring-before-receipt-injection.json')
  writeFileSync(completedSnapshotFile, completedBefore)
  const intent = JSON.parse(completedBefore)
  assert.equal(intent.status, 'completed')
  assert.equal(intent.scopeSettled, true)
  assert.equal(json(proof.rootFile).planningRequestHash, digest(intent.fingerprint))
  intent.status = 'failed'
  intent.error = 'synthetic final planning receipt failure; canonical root retained'
  writeFileSync(proof.file, JSON.stringify(intent))
  const failedBefore = readFileSync(proof.file)
  const task = json(proof.taskFile)
  assert.equal(task.state.kind, 'associated')
  task.revision += 1
  task.state = { ...task.state, kind: 'unknown', reason: 'synthetic association acknowledgement failure' }
  writeFileSync(proof.taskFile, JSON.stringify(task))
  const unknownTaskBefore = readFileSync(proof.taskFile)
  await evaluate(`window.scry.setCwd(${JSON.stringify(fixture.cwd)})`)
  const expression = `window.scry.workflow.plan(${JSON.stringify(proof.request)})`
  const previews = await evaluate(`Promise.all([${expression}, ${expression}])`)
  for (const preview of previews) {
    assert.equal(preview.workflowId, proof.workflowId)
    assert.equal(preview.programRevision, json(proof.rootFile).preview.programRevision)
  }
  assert.deepEqual(readFileSync(fixture.callsFile), callsBefore, 'receipt recovery dispatched another Provider')
  assert.deepEqual(readFileSync(proof.rootFile), rootBefore, 'receipt recovery rewrote the canonical root')
  assert.deepEqual(readFileSync(proof.file), failedBefore, 'observation upgraded the failed planning receipt')
  assert.equal(digest(readFileSync(proof.outputFile)), proof.outputSha256)
  assert.deepEqual(readFileSync(proof.taskFile), unknownTaskBefore, 'root observation reopened the unknown task fence')
  const result = { syntheticFailedReceiptObserved: true, canonicalRootAndCandidateUnchanged: true,
    completedSnapshotFile, failedReceiptByteUnchanged: true, unknownTaskFenceByteUnchanged: true,
    concurrentRecoveryProviderCalls: 0, workflowId: proof.workflowId }
  writeFileSync(join(fixture.userData, 'workflow-planning-receipt-proof.json'), JSON.stringify(result, null, 2))
  return result
}

export function verifyWorkflowAuthoringCold(proof) {
  assert.equal(digest(readFileSync(proof.taskFile)), proof.taskSha256, 'cold observation rewrote task association')
  assert.equal(digest(readFileSync(proof.inputFile)), proof.inputSha256, 'cold observation rewrote immutable task input')
  assert.equal(digest(readFileSync(proof.file)), proof.sha256, 'cold observation rewrote completed planning metadata')
  assert.equal(digest(readFileSync(proof.outputFile)), proof.outputSha256, 'cold observation rewrote the canonical candidate')
  assert.equal(digest(readFileSync(proof.identityFence.taskFile)), proof.identityFence.taskSha256,
    'cold observation reopened an identity-rejected task')
  return { metadataAndCandidateByteUnchanged: true, identityRejectedTaskByteUnchanged: true, source: json(proof.file).result.outputSource }
}
