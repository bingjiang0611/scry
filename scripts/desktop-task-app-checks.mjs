import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const digest = value => createHash('sha256').update(value).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const submissionId = request => `submission-${digest(JSON.stringify([request.conversationId, request.commandId]))}`
const taskFile = (fixture, request) => join(fixture.userData, 'conversation-submissions-v1', request.conversationId, `${submissionId(request)}.json`)
export const publish = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.probe`, JSON.stringify(value))
  renameSync(`${path}.probe`, path)
}
const calls = fixture => readFileSync(fixture.callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
async function wait(predicate, message) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  assert.fail(message)
}
export function verifyBody(fixture, request, version = 1) {
  const file = taskFile(fixture, request)
  const task = json(file)
  assert.equal(task.version, version)
  assert.equal(task.snapshot.source, version === 1 ? 'desktop_conversation_send' : 'desktop_conversation_submit')
  assert.deepEqual(task.snapshot.policy, { mode: 'off', revision: 0 })
  const ref = task.snapshot.input
  const content = join(fixture.userData, 'conversation-submissions-v1', request.conversationId,
    `${submissionId(request)}.input`, 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`)
  const bytes = readFileSync(content)
  assert.equal(bytes.length, ref.bytes)
  assert.equal(digest(bytes), ref.sha256)
  assert.equal(JSON.parse(bytes.toString('utf8')).originalGoal, request.prompt)
  return { file, hash: digest(readFileSync(file)), content, contentHash: ref.sha256, task }
}

/** Separate opt-in workload. Original ownership controls run unchanged first.
 * Uses real trusted IPC/Main and the existing offline smoke Provider only. */
export async function exerciseDesktopTasks(evaluate, fixture) {
  const conversation = await evaluate(`window.scry.conversations.create(${JSON.stringify(fixture.cwd)})`)
  const makeRequest = async prompt => {
    const preview = await evaluate(`window.scry.conversations.preview(${JSON.stringify(conversation.id)}, { providerId: 'codex', permissionMode: 'default' })`)
    return { conversationId: conversation.id, expectedRevision: preview.revision,
      expectedContinuationKey: preview.target.continuationKey, commandId: randomUUID(),
      providerId: 'codex', permissionMode: 'default', selectedItems: [], confirmFresh: true, prompt }
  }
  const send = request => evaluate(`window.scry.conversations.send(${JSON.stringify(request)})`)
  const submitRaw = request => evaluate(`window.scry.conversations.submit(${JSON.stringify(request)})`)
  const submissionOutcome = request => evaluate(`(async () => {
    try { return { value: await window.scry.conversations.submit(${JSON.stringify(request)}) } }
    catch (error) { return { error: String(error) } }
  })()`)
  const envelope = (request, selectedCommandId) => {
    const { conversationId, expectedRevision, commandId, prompt, ...message } = request
    return { conversationId, expectedRevision, commandId, prompt, selectedCommandId, message }
  }
  const outcome = request => evaluate(`(async () => {
    try { return { value: await window.scry.conversations.send(${JSON.stringify(request)}) } }
    catch (error) { return { error: String(error) } }
  })()`)
  const waitAccepted = async runId => {
    await wait(async () => {
      const page = await evaluate(`window.scry.conversations.read(${JSON.stringify(conversation.id)})`)
      return page.turns.some(turn => turn.runId === runId && turn.delivery.status === 'accepted' && turn.delivery.outcome === 'completed')
    }, 'direct task did not reach a canonical accepted terminal turn')
  }
  const before = calls(fixture).length
  const conversationFile = join(fixture.userData, 'conversations', `${conversation.id}.json`)
  const originalConversation = readFileSync(conversationFile)
  const commandTarget = { providerId: 'codex', permissionMode: 'default' }
  const getCommands = request => evaluate(`(async () => {
    try { return { value: await window.scry.conversations.commands(${JSON.stringify(conversation.id)}, ${JSON.stringify(request)}) } }
    catch (error) { return { error: String(error) } }
  })()`)
  const knownCommands = await getCommands(undefined)
  assert.equal(knownCommands.value?.provider.state, 'unknown')
  assert.equal(knownCommands.value?.provider.complete, false)
  assert.deepEqual(knownCommands.value?.commands.map(command => command.id), ['scry:workflow'])
  const catalogue = await getCommands(commandTarget)
  assert.ok(catalogue.value, `production command catalogue failed: ${JSON.stringify(catalogue)}`)
  assert.match(catalogue.value.scope, /^[a-f0-9]{64}$/)
  // The existing FakeProvider intentionally has no native command facet. This
  // is unsupported evidence, not an available empty native catalogue.
  assert.equal(catalogue.value.provider.state, 'unsupported')
  assert.equal(catalogue.value.provider.complete, false)
  assert.deepEqual(catalogue.value.commands.map(command => ({ id: command.id, origin: command.origin })),
    [{ id: 'scry:workflow', origin: { kind: 'scry_workflow' } }])
  for (const injected of [{ source: 'scry_workflow' }, { origin: 'human' }, { cwd: fixture.otherCwd }]) {
    assert.ok((await getCommands({ ...commandTarget, ...injected })).error, 'renderer-controlled source/workspace must be rejected')
  }
  const unregistered = join(dirname(fixture.userData), 'unregistered-command-workspace')
  mkdirSync(unregistered)
  try {
    // Fault injection changes only this temporary App-owned record. The real
    // handler must still authorize its canonical workspace before discovery.
    writeFileSync(conversationFile, JSON.stringify({ ...JSON.parse(originalConversation.toString('utf8')), cwd: unregistered }))
    const unauthorized = await getCommands(commandTarget)
    assert.match(unauthorized.error ?? '', /工作目录尚未通过 Scry 目录选择器授权/)
    const refusedControl = await submissionOutcome({ conversationId: conversation.id, expectedRevision: 0,
      commandId: randomUUID(), prompt: '/scry-workflow size small', selectedCommandId: 'scry:workflow' })
    assert.match(refusedControl.error ?? '', /工作目录尚未通过 Scry 目录选择器授权/)
  } finally { writeFileSync(conversationFile, originalConversation) }
  assert.equal(digest(readFileSync(conversationFile)), digest(originalConversation))
  assert.equal(calls(fixture).length, before, 'catalogue reads must not add an Agent run')
  assert.equal(existsSync(join(fixture.userData, 'conversation-submissions-v1', conversation.id)), false)
  const catalogueProof = { nativeState: catalogue.value.provider.state, nativeComplete: false,
    mainOwnedScrySelector: true, rendererSourceRejected: true, unregisteredWorkspaceRejected: true,
    conversationByteUnchanged: true, taskRowsCreated: 0, additionalAgentRuns: 0 }
  const control = { conversationId: conversation.id, expectedRevision: 0, commandId: randomUUID(),
    prompt: '/scry-workflow list', selectedCommandId: 'scry:workflow' }
  assert.deepEqual(await submitRaw(control), { kind: 'control', commandId: control.commandId, action: 'open_workflows' })
  for (const extra of [{ origin: 'human' }, { source: 'scry_workflow' }, { cwd: fixture.otherCwd }, { mode: 'auto' }]) {
    assert.ok((await submissionOutcome({ ...control, ...extra })).error, 'typed submission accepted renderer authority')
  }
  const preferenceFile = join(fixture.userData, 'workflows', 'preferences.json')
  const small = await submitRaw({ ...control, commandId: randomUUID(), prompt: '/scry-workflow size small' })
  assert.equal(small.action, 'size_updated')
  assert.equal(small.snapshot.value, 'small')
  assert.equal(small.snapshot.source, 'preference')
  assert.equal(json(preferenceFile).workflowSizeGuideline, 'small', 'CLI response did not match persisted size preference')
  const defaultSize = await submitRaw({ ...control, commandId: randomUUID(), prompt: '/scry-workflow size default' })
  assert.equal(defaultSize.snapshot.value, 'medium')
  assert.equal(defaultSize.snapshot.source, 'default')
  assert.equal('workflowSizeGuideline' in json(preferenceFile), false, 'default must remove the explicit preference')
  const preferenceBytes = readFileSync(preferenceFile)
  for (const request of [
    { ...control, message: { attachments: [{ dataBase64: 'unconsumed' }] } },
    { ...control, prompt: '/scry-workflow run preserve context', message: { selectedItems: [{ runId: 'unconsumed' }] } },
    { ...control, prompt: '/scry-workflow invalid' },
    { ...control, expectedRevision: 1 }
  ]) {
    const rejected = await submitRaw({ ...request, commandId: randomUUID() })
    assert.equal(rejected.kind, 'rejected', 'known pre-effect refusal must not become an unknown write')
    assert.ok(rejected.error)
  }
  assert.equal(digest(readFileSync(preferenceFile)), digest(preferenceBytes))
  const ambiguousSource = await submitRaw({ ...control, commandId: randomUUID(), selectedCommandId: undefined,
    message: commandTarget })
  assert.equal(ambiguousSource.kind, 'needs_command_source')
  assert.equal(ambiguousSource.catalog.provider.complete, false)
  const plannerRequest = { ...control, commandId: randomUUID(), prompt: '/scry-workflow run preserve exact goal' }
  const plannerControl = await submitRaw(plannerRequest)
  const captured = verifyBody(fixture, plannerRequest, 2)
  assert.equal(captured.task.state.kind, 'captured')
  assert.equal(captured.task.snapshot.operation, 'workflow_run')
  assert.equal('target' in captured.task.snapshot, false)
  assert.deepEqual(plannerControl, { kind: 'control', commandId: plannerRequest.commandId,
    action: 'open_workflow_planner', command: plannerRequest.prompt, workspace: fixture.cwd,
    submission: { reference: { conversationId: conversation.id, commandId: plannerRequest.commandId },
      planningCommandId: captured.task.submissionId, size: captured.task.snapshot.size } })
  const controlSettings = join(fixture.userData, 'workflows', 'settings.json')
  const savedSettings = existsSync(controlSettings) ? readFileSync(controlSettings) : undefined
  const preferencesBeforeOverride = readFileSync(preferenceFile)
  try {
    writeFileSync(controlSettings, JSON.stringify({ workflowSizeGuideline: 'large' }))
    assert.match((await submissionOutcome({ ...control, commandId: randomUUID(), prompt: '/scry-workflow size small' })).error ?? '', /settings.json.*覆盖/)
    assert.equal(digest(readFileSync(preferenceFile)), digest(preferencesBeforeOverride), 'rejected CLI size change mutated preferences')
  } finally {
    if (savedSettings === undefined) unlinkSync(controlSettings)
    else writeFileSync(controlSettings, savedSettings)
  }
  const noContext = await submitRaw({ conversationId: conversation.id, expectedRevision: 0,
    commandId: randomUUID(), prompt: 'ordinary task without native context' })
  assert.deepEqual(noContext, { kind: 'needs_native_context' })
  assert.equal(calls(fixture).length, before, 'settings/list/context negotiation invoked an actor')
  assert.deepEqual(readdirSync(dirname(captured.file)).filter(name => name.endsWith('.json')), [captured.task.submissionId + '.json'])
  assert.equal(digest(readFileSync(captured.file)), captured.hash)
  assert.equal(digest(readFileSync(conversationFile)), digest(originalConversation))
  const controlProof = { listReturnedManagementAction: true, sizePreferenceAndDefaultVerified: true, fileOverrideRejectedWithoutWrite: true,
    knownRefusalsReturnedAsData: true, partialAttachmentContextRefused: true, sourceRequiredReturnedAsData: true, plannerConfigurationActionOnly: true,
    contextNegotiationDidNotDispatch: true, sourceSpoofRejected: true, taskRowsCreated: 1, additionalAgentRuns: 0,
    capturedWorkflowWithoutNativeContext: true, workflowCapture: { file: captured.file, hash: captured.hash,
      content: captured.content, contentHash: captured.contentHash } }
  const first = await makeRequest('  Preserve this original task goal.\n')
  const forged = { ...first, commandId: randomUUID(), source: 'human', mode: 'auto' }
  assert.ok((await outcome(forged)).error, 'renderer must not declare task origin or mode')
  assert.equal(calls(fixture).length, before)
  assert.equal(existsSync(taskFile(fixture, forged)), false)
  const firstResult = await submitRaw(envelope(first))
  assert.equal(firstResult.kind, 'direct')
  await waitAccepted(firstResult.runId)
  const firstProof = verifyBody(fixture, first)
  assert.equal(firstProof.task.state.kind, 'associated')
  assert.equal(firstProof.task.state.runId, firstResult.runId)
  assert.equal(calls(fixture).length, before + 1, 'off-mode submission must not add a routing/planning call')

  const secondGoal = 'Coalesce one direct task, even with unavailable workflow size settings.'
  const second = await makeRequest(`/scry-workflow direct ${secondGoal}`)
  const settings = join(fixture.userData, 'workflows', 'settings.json')
  const previousSettings = existsSync(settings) ? readFileSync(settings) : undefined
  mkdirSync(dirname(settings), { recursive: true })
  writeFileSync(settings, 'null')
  let secondResult
  try {
    const results = await Promise.all([submitRaw(envelope(second, 'scry:workflow')), submitRaw(envelope(second, 'scry:workflow'))])
    assert.equal(results[0].runId, results[1].runId)
    assert.deepEqual(results.map(result => result.disposition).sort(), ['created', 'duplicate'])
    secondResult = results[0]
    await waitAccepted(secondResult.runId)
  } finally {
    if (previousSettings === undefined) unlinkSync(settings)
    else writeFileSync(settings, previousSettings)
  }
  const secondProof = verifyBody(fixture, second)
  assert.equal(secondProof.task.snapshot.size.state, 'unavailable')
  assert.equal('snapshot' in secondProof.task.snapshot.size, false)
  assert.deepEqual(json(secondProof.content).command, { id: 'scry:workflow', origin: 'scry_workflow', operation: 'direct' })
  const adapterInputs = readFileSync(join(fixture.userData, 'desktop-task-provider-inputs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const directInput = adapterInputs.find(input => input.runId === secondResult.runId)
  assert.equal(directInput?.prompt, secondGoal, 'actual adapter did not receive the resolved direct goal')
  assert.equal(calls(fixture).length, before + 2, 'concurrent duplicate reached the adapter twice')
  assert.ok((await submissionOutcome(envelope({ ...second, prompt: `/scry-workflow direct ${secondGoal} changed` }, 'scry:workflow'))).error)
  assert.equal(digest(readFileSync(secondProof.file)), secondProof.hash)
  assert.equal(calls(fixture).length, before + 2)

  const third = await makeRequest('A closed task fence must prevent actual Provider entry.')
  const gateFile = join(fixture.userData, 'task-dispatch-gate.json')
  const marker = join(fixture.userData, 'task-dispatch-gate-entered.json')
  const gate = { hold: true, cwd: conversation.cwd, conversationId: conversation.id, commandId: third.commandId }
  publish(gateFile, gate)
  const attempt = outcome(third)
  const evidenceFile = join(fixture.userData, 'task-dispatch-fence-proof.json')
  let fenceProof
  try {
    await wait(() => existsSync(marker) || calls(fixture).length > before + 2,
      'neither a pending-turn native-key gate nor a Provider entry was observed')
    const earlyCalls = calls(fixture).length - before - 2
    if (earlyCalls) {
      publish(evidenceFile, { expectedAdditionalProviderCalls: 0, actualAdditionalProviderCalls: earlyCalls,
        gateObserved: existsSync(marker), api: await attempt, reason: 'Provider entered before the task snapshot guard' })
      assert.equal(earlyCalls, 0, 'Provider entered before the Main task-snapshot revalidation gate')
    }
    assert.equal(json(marker).commandId, third.commandId)
    const task = json(taskFile(fixture, third))
    assert.ok(['dispatch_intent', 'associated'].includes(task.state.kind))
    const frozen = JSON.stringify(task.snapshot)
    // Valid durable fence transition in this isolated fixture. Unit tests use
    // the real Store mutator; here the independent process controls the race.
    const fenced = { ...task, revision: task.revision + 1,
      state: { kind: 'unknown', branch: 'direct', ownerEpoch: task.state.ownerEpoch, reason: 'fixture closed the intake fence',
        ...(task.state.kind === 'associated' ? { runId: task.state.runId } : {}) } }
    publish(taskFile(fixture, third), fenced)
    publish(gateFile, { ...gate, hold: false })
    const api = await attempt
    const conversationFile = join(fixture.userData, 'conversations', `${conversation.id}.json`)
    await wait(() => json(conversationFile).turns.some(turn => turn.commandId === third.commandId && turn.delivery.status === 'not_sent'),
      'closed task fence did not produce canonical not_sent evidence')
    const after = json(taskFile(fixture, third))
    assert.equal(after.state.kind, 'unknown')
    assert.equal(JSON.stringify(after.snapshot), frozen)
    assert.equal(calls(fixture).length, before + 2, 'closed task fence still entered the real adapter')
    const duplicate = await send(third)
    assert.equal(duplicate.disposition, 'duplicate')
    assert.equal(json(taskFile(fixture, third)).state.kind, 'unknown', 'observation must not reopen the dispatch fence')
    assert.equal(calls(fixture).length, before + 2)
    fenceProof = { expectedAdditionalProviderCalls: 0, actualAdditionalProviderCalls: 0,
      gateObserved: true, canonicalDelivery: 'not_sent', unknownFenceRetained: true, api, duplicate }
    publish(evidenceFile, fenceProof)
  } finally { publish(gateFile, { ...gate, hold: false }) }
  return { test: 'main-owned desktop task default-off entry', sourceSpoofRejected: true,
    immutableOriginalGoalVerified: true, extraRoutingCalls: 0, concurrentDuplicateCalls: 1,
    unavailableSizeDidNotBlockDirect: true, changedPayloadRejected: true, fenceProof, catalogueProof, controlProof,
    scryDirectOriginalCommandAndAdapterGoalVerified: true,
    retained: [firstProof, secondProof, captured].map(({ file, hash, content, contentHash }) => ({ file, hash, content, contentHash })) }
}

export function verifyDesktopTaskColdEvidence(proof) {
  for (const item of proof.retained) {
    assert.equal(digest(readFileSync(item.file)), item.hash, 'cold startup rewrote an existing task submission')
    assert.equal(digest(readFileSync(item.content)), item.contentHash, 'cold startup rewrote the immutable original input')
  }
  return { completedAndCapturedSnapshotsByteUnchanged: true, inputBodiesByteUnchanged: true }
}
