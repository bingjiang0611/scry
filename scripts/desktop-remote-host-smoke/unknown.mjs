import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { detail, progressMarkers, submitWithUnknownTransport, tlsRequest, waitForRun } from './harness.mjs'

// The exactly-once/unknown branch: a dropped receipt is resolved through
// intentStatus or an explicit recovery fence, never by resending the prompt.
export async function verifyUnknownReceipt({ transport, evaluate, submit, invitation, identity, deviceCertPEM, canonicalWorkspace }) {
  // A dropped receipt is resolved through intentStatus, never by sending a new
  // intent id. This is the canonical exactly-once/unknown branch.
  const unknownIntentId = randomUUID()
  await submitWithUnknownTransport({
    port: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM,
    request: { op: 'submit', intentId: unknownIntentId, detail: detail(canonicalWorkspace, 'desktop remote unknown receipt smoke') }
  })
  let unknown
  const unknownDeadline = Date.now() + 10_000
  while (Date.now() < unknownDeadline) {
    unknown = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'intentStatus', intentId: unknownIntentId })
    if (unknown.intent?.runId) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  assert.ok(unknown?.intent?.runId, `unknown intent was not durably recorded: ${JSON.stringify(unknown)}`)
  const unknownRunId = unknown.intent.runId
  const unknownAgain = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'intentStatus', intentId: unknownIntentId })
  assert.equal(unknownAgain.intent.runId, unknownRunId)
  await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: unknownRunId, expect: 'settled' })

  // Explicit recovery reuses accepted evidence; an absent id instead gets a
  // durable cancellation fence. Neither branch can replay the original prompt.
  const recovered = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'resolveIntent', intentId: unknownIntentId })
  assert.equal(recovered.intent.runId, unknownRunId)
  assert.equal(recovered.intent.state, 'settled')
  const absentIntentId = randomUUID()
  const fenced = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'resolveIntent', intentId: absentIntentId })
  assert.equal(fenced.intent.state, 'cancelled')
  const fencedAgain = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'resolveIntent', intentId: absentIntentId })
  assert.deepEqual(fencedAgain, fenced)
  assert.deepEqual(await submit(absentIntentId, 'must never execute a delayed submission'), { error: 'intent_payload_conflict' })
  const bridgeRejection = await evaluate(`window.scry.desktopRemote.resolveIntent('missing-connection', ${JSON.stringify(absentIntentId)}).then(() => 'unexpected success', error => error.message)`)
  assert.match(bridgeRejection, /unknown_connection/, 'production preload/IPC recovery must reach main validation')
}
