import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { detail, progressMarkers, tlsRequest, waitForRun } from './harness.mjs'

// Run lifecycle over the device channel: submit, dedupe, watch, trace, history,
// session actions and resume. Returns the helpers the later phases reuse.
export async function verifyRuns({ transport, evaluate, invitation, identity, deviceCertPEM, canonicalWorkspace, info, temp }) {
  const context = { cwd: canonicalWorkspace, providerId: 'codex' }
  const submit = async (intentId, prompt, extra = {}) => tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'submit', intentId, detail: detail(canonicalWorkspace, prompt, extra)
  })
  const normalIntentId = randomUUID()
  const normal = await submit(normalIntentId, 'desktop remote write one')
  assert.equal(normal.status, 'recorded')
  const duplicate = await submit(normalIntentId, 'desktop remote write one')
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.runId, normal.runId)
  const normalWatch = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: normal.runId, expect: 'settled' })
  const normalMarkers = progressMarkers(normalWatch, normal.runId)
  const normalSession = normalMarkers.find((marker) => marker.event === 'session')?.externalSessionId
  const normalScryRunId = normalMarkers.find((marker) => marker.event === 'bound')?.scryRunId
  assert.match(normalSession, /^smoke-session-/)
  assert.match(normalScryRunId, /^remote-run-/)
  const trace = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'trace', context: { ...context, externalSessionId: normalSession }, runId: normalScryRunId }
  })
  assert.equal(trace.desktop.kind, 'trace')
  assert.equal(trace.desktop.run, null, 'settled execution must be released; evidence is retained in archive')
  const history = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'history', context: { ...context, externalSessionId: normalSession } }
  })
  assert.equal(history.desktop.kind, 'history')
  assert.equal(history.desktop.history.source, 'trace_archive')
  assert.equal(history.desktop.history.status, 'available')
  assert.ok(history.desktop.history.turns.length > 0 && history.desktop.history.turns.length <= 10_000)
  assert.ok(history.desktop.history.turns.some((turn) => turn.items.some((item) => item.stage === 'tool_result')))
  const sessionContext = { ...context, externalSessionId: normalSession }
  const sessionAction = (target, action) => tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'sessionAction', context: target, action })
  const sessionPage = (includeArchived = true) => tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'sessionsPage', includeArchived })
  assert.equal(info.desktop.sessionActions, true)
  const commands = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'commands', ...context })
  assert.ok(Array.isArray(commands.commands.commands), 'commands must come from the host catalog even when unavailable')
  assert.equal((await sessionAction(sessionContext, { kind: 'rename', title: 'Host-owned title' })).sessionAction, true)
  assert.equal((await sessionAction(sessionContext, { kind: 'pin', pinned: true })).sessionAction, true)
  const renamed = (await sessionPage()).sessionsPage.sessions.find(session => session.externalSessionId === normalSession)
  assert.equal(renamed.label, 'Host-owned title')
  assert.ok(renamed.pinnedAt > 0)
  const hostProjects = await evaluate('window.scry.listProjects()')
  assert.ok(hostProjects.some(project => project.sessions.some(session => session.externalSessionId === normalSession && session.preview === 'Host-owned title')), 'remote metadata did not update the actual host sidebar store')
  const deniedMetadata = await sessionAction({ ...sessionContext, cwd: join(temp, 'not-authorized') }, { kind: 'rename', title: 'Denied title' })
  assert.ok(deniedMetadata.error, 'unauthorized workspace mutation must fail')
  assert.equal((await sessionAction(sessionContext, { kind: 'archive', archived: true })).sessionAction, true)
  assert.ok((await sessionPage()).sessionsPage.sessions.find(session => session.externalSessionId === normalSession)?.archivedAt)
  assert.ok(!(await sessionPage(false)).sessionsPage.sessions.some(session => session.externalSessionId === normalSession), 'legacy/mobile catalog exposed archived rows')
  assert.equal((await sessionAction(sessionContext, { kind: 'archive', archived: false })).sessionAction, true)
  assert.equal((await sessionAction(sessionContext, { kind: 'pin', pinned: false })).sessionAction, true)
  assert.ok(!(await sessionPage()).sessionsPage.sessions.find(session => session.externalSessionId === normalSession).pinnedAt)
  const resumed = await submit(randomUUID(), 'desktop remote write two', { resume: normalSession })
  const resumedWatch = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: resumed.runId, expect: 'settled' })
  const resumedRunId = progressMarkers(resumedWatch, resumed.runId).find(marker => marker.event === 'bound')?.scryRunId
  const resumedHistory = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'history', context: { ...context, externalSessionId: normalSession } }
  })
  const resumedTurn = resumedHistory.desktop.history.turns.find(turn => turn.runId === resumedRunId)
  assert.ok(resumedTurn, 'resumed turn is not in the same durable session')
  const sessionDiff = resumedTurn.items.find(item => item.stage === 'session_diff')?.turnDiff
  assert.equal(sessionDiff?.status, 'captured')
  assert.equal(sessionDiff.baseline, 'session_start', 'resume must retain the first-turn baseline')
  for (const name of ['remote-first.txt', 'remote-second.txt']) {
    assert.ok(sessionDiff.files.some(file => file.path.endsWith(name)), `session diff lost ${name}`)
  }
  return { context, submit, sessionAction, sessionPage, normalSession, sessionContext, history }
}
