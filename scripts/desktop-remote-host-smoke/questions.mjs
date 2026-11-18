import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { progressMarkers, tlsRequest, waitForRun } from './harness.mjs'

// Question lifecycle, delta reads on a live run, admission isolation and
// archiving a running session.
export async function verifyQuestions({ transport, evaluate, submit, sessionAction, invitation, identity, deviceCertPEM, context }) {
  // The fixture has a real question lifecycle. Stop while its question is open;
  // no synthetic answer is injected and the terminal status must be observed.
  const question = await submit(randomUUID(), 'dock badge question smoke')
  let questionWatch
  const questionDeadline = Date.now() + 10_000
  while (Date.now() < questionDeadline) {
    questionWatch = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'watch', runId: question.runId, cursor: 0, outputCursor: 0, waitMs: 1_000 })
    if (questionWatch.watch?.questions?.length) break
  }
  assert.ok(questionWatch?.watch?.questions?.length, 'question fixture did not reach a pending question')
  const questionMarkers = progressMarkers(questionWatch, question.runId)
  const questionScryRunId = questionMarkers.find(marker => marker.event === 'bound')?.scryRunId
  const questionSession = questionMarkers.find(marker => marker.event === 'session')?.externalSessionId
  const activeTrace = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'trace', context: { ...context, externalSessionId: questionSession }, runId: questionScryRunId }
  })
  assert.equal(activeTrace.desktop.run.done, false)
  assert.equal(activeTrace.desktop.run.runId, questionScryRunId)
  assert.ok(activeTrace.desktop.run.pendingQuestions.length > 0)
  // Delta reads on the production live run: a cursor-less read is a reset
  // snapshot; continuing from it returns only metadata and changed indices;
  // a foreign context is still rejected on the delta path.
  const activeQuery = { kind: 'trace', context: { ...context, externalSessionId: questionSession }, runId: questionScryRunId }
  const deltaReset = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktop', query: { ...activeQuery, delta: {} } })
  assert.equal(deltaReset.desktop.kind, 'trace')
  assert.equal(deltaReset.desktop.reset, true)
  assert.deepEqual(deltaReset.desktop.run.items, activeTrace.desktop.run.items)
  const after = { revision: deltaReset.desktop.revision, count: deltaReset.desktop.run.items.length }
  const deltaNext = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktop', query: { ...activeQuery, delta: { after } } })
  assert.equal(deltaNext.desktop.kind, 'trace_delta')
  assert.equal(deltaNext.desktop.base, after.revision)
  assert.equal('items' in deltaNext.desktop.run, false)
  assert.ok(deltaNext.desktop.changes.every((change) => change.index < deltaNext.desktop.count))
  // Same run id under another Agent profile: the full read and the delta read share one authorization result.
  const foreignQuery = { ...activeQuery, context: { ...activeQuery.context, agentProfileId: 'another-profile' } }
  const foreignFull = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktop', query: foreignQuery })
  const foreignDelta = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktop', query: { ...foreignQuery, delta: { after } } })
  assert.equal(foreignFull.error, 'run_context_mismatch')
  assert.equal(foreignDelta.error, 'run_context_mismatch')
  const adopted = await evaluate(`window.scry.adoptActiveRun(${JSON.stringify(questionScryRunId)})`)
  assert.equal(adopted.runId, questionScryRunId)
  // A different fresh session must settle while the first is still awaiting
  // input. Sequential submissions would not detect an admission lock leak.
  const second = await submit(randomUUID(), 'desktop remote independent session smoke')
  const secondWatch = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: second.runId, expect: 'settled' })
  const secondSession = progressMarkers(secondWatch, second.runId).find(marker => marker.event === 'session')?.externalSessionId
  assert.match(secondSession, /^smoke-session-/)
  assert.notEqual(secondSession, questionSession)
  const stopped = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'stop', runId: question.runId })
  assert.ok(['requested', 'already_requested'].includes(stopped.stop?.status))
  const cancelled = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: question.runId })
  const cancelMarkers = progressMarkers(cancelled, question.runId)
  assert.ok(cancelMarkers.some((marker) => marker.event === 'settled' && ['interrupted', 'cancelled'].includes(marker.status)), JSON.stringify(cancelled))
  const interruptedHistory = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'history', context: { ...context, externalSessionId: questionSession } }
  })
  const adoptedDiff = interruptedHistory.desktop.history.turns.flatMap(turn => turn.items).find(item => item.stage === 'session_diff')?.turnDiff
  assert.equal(adoptedDiff?.status, 'captured', 'Mac adoption must not detach the remote run baseline')

  const archiveRun = await submit(randomUUID(), 'dock badge question smoke')
  let archiveWatch
  const archiveDeadline = Date.now() + 10_000
  while (Date.now() < archiveDeadline) {
    archiveWatch = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'watch', runId: archiveRun.runId, cursor: 0, outputCursor: 0, waitMs: 1_000 })
    if (archiveWatch.watch?.questions?.length) break
  }
  assert.ok(archiveWatch?.watch?.questions?.length, 'archive fixture did not reach a running session')
  const archiveNativeSession = progressMarkers(archiveWatch, archiveRun.runId).find(marker => marker.event === 'session')?.externalSessionId
  assert.ok(archiveNativeSession)
  assert.equal((await sessionAction({ ...context, externalSessionId: archiveNativeSession }, { kind: 'archive', archived: true })).sessionAction, true)
  const archivedRun = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: archiveRun.runId })
  assert.ok(progressMarkers(archivedRun, archiveRun.runId).some(marker => marker.event === 'settled' && ['interrupted', 'cancelled'].includes(marker.status)), 'archiving did not stop the owning host run')
  return { activeTrace }
}
