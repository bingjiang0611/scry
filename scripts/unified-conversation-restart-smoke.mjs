import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { verifyConversationDeletionRestart } from './conversation-deletion-smoke.mjs'

const json = JSON.stringify
const inputs = (fixture) => existsSync(fixture.inputsFile) ? readFileSync(fixture.inputsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const wait = async (probe, label) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}
const read = (evaluate, id) => evaluate(`window.scry.conversations.read(${json(id)})`)
const preview = (evaluate, id, providerId) => evaluate(`window.scry.conversations.preview(${json(id)}, {providerId:${json(providerId)}})`)

export async function verifyUnifiedConversationRestart(evaluate, fixture, result, changedIdentity) {
  await wait(() => evaluate('Boolean(window.scry?.conversations)'), 'restarted preload ready')
  const page = await read(evaluate, result.id)
  assert.deepEqual(page.turns.map((turn) => turn.runId), result.runIds)
  assert.equal(page.bindings.length, 2)
  assert.equal(page.summary.lastRunOutcome, 'completed', 'logical completion survives restart')
  assert.ok(page.turns.every((turn) => turn.delivery.status === 'accepted' && turn.history?.done === true))
  assert.equal((await read(evaluate, result.unknownId)).turns[0].delivery.status, 'unknown')
  const pi = await read(evaluate, result.piSwitch.id)
  assert.deepEqual(pi.turns.map(turn => turn.runId), result.piSwitch.runIds)
  const piPlan = await evaluate(`window.scry.conversations.preview(${json(result.piSwitch.id)}, {providerId:'pi',agentProfileId:${json(result.piSwitch.profile)}})`)
  assert.equal(piPlan.continuation.kind, changedIdentity ? 'fresh' : 'resume')
  assert.equal(piPlan.missingItems.length, changedIdentity ? 10 : 0)
  const archiveFailure = await read(evaluate, result.archiveFailure.id)
  assert.equal(archiveFailure.turns[0].delivery.status, 'unknown')
  assert.equal(archiveFailure.summary.lastRunOutcome, undefined, 'unknown delivery must not be displayed as completed')
  assert.equal(archiveFailure.turns[0].history, undefined)
  assert.ok(archiveFailure.summary.blockedReason)
  assert.deepEqual(await evaluate(`window.scry.conversations.send(${json(result.duplicate)})`), { runId: result.runIds[2], disposition: 'duplicate' })
  assert.equal(page.summary.title, result.management.originalTitle)
  assert.ok(page.summary.pinnedAt)
  const adopted = await read(evaluate, result.management.id)
  assert.equal(adopted.turns[0].runId, result.management.runId)
  assert.equal(adopted.turns[0].delivery.status, 'imported')
  assert.equal(adopted.turns[1].runId, result.management.nextRunId)
  assert.equal(adopted.turns[1].delivery.status, 'accepted')
  assert.equal(adopted.bindings.length, 2)
  assert.equal((await evaluate(`window.scry.conversations.adopt(${json(result.management.source)},${json(result.management.fingerprint)})`)).id, result.management.id)
  const next = await preview(evaluate, result.id, 'claude')
  assert.equal(next.continuation.kind, changedIdentity ? 'fresh' : 'resume')
  assert.equal(next.missingItems.length, changedIdentity ? 6 : 0)
  for (const id of [result.nativeFork.sourceId, result.nativeFork.branchId]) {
    assert.equal((await read(evaluate, id)).summary.deletion.status, 'complete')
  }
  const forkCalls = readFileSync(fixture.callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(call => call.operation === 'fork')
  assert.equal(forkCalls.length, result.nativeFork.forkCalls, 'restart cannot recreate the native branch')
  await verifyConversationDeletionRestart(evaluate, fixture, result.deletion, inputs)
  assert.deepEqual(inputs(fixture), result.receipts, 'restart/read/preview/duplicate must not execute the Provider again')
}
