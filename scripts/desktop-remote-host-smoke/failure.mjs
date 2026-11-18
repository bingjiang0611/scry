import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { waitForRun } from './harness.mjs'

// A committed Provider failure must stay a failure, and the recorder artifacts it
// leaves behind must stay bounded.
export async function verifyFailureAndRecords({ transport, submit, invitation, identity, deviceCertPEM, normalSession, workspace }) {
  // A real adapter rejection after publishing its native session exercises the
  // production runtime rejection/recording/finally branches, not input rejection.
  const failed = await submit(randomUUID(), 'remote provider failure smoke')
  const failedWatch = await waitForRun({ transport, runPort: invitation.runPort, caPEM: invitation.anchorPEM, certPEM: deviceCertPEM, keyPEM: identity.keyPEM, runId: failed.runId, expect: 'failed' })
  assert.equal(failedWatch.watch.state, 'failed')
  const failureEvent = failedWatch.watch.poll.events.find(event => event.runId === failed.runId && event.kind === 'run_failed')
  assert.equal(failureEvent.detail, 'fixture_provider_failure', 'committed Provider error must not become an unknown recording failure')

  const scryEntries = readdirSync(join(workspace, '.scry'))
  for (const entry of scryEntries) {
    const info = statSync(join(workspace, '.scry', entry))
    assert.ok(info.size <= 4 * 1024 * 1024, `unbounded .scry artifact: ${entry}`)
  }
  const recordsDir = join(workspace, '.scry', 'records')
  const recordFiles = readdirSync(recordsDir, { recursive: true }).filter(name => name.endsWith('.json'))
  const records = recordFiles.map(name => JSON.parse(readFileSync(join(recordsDir, name), 'utf8'))).filter(record => record.recordKind === 'agent_turn')
  const normalRecord = records.find(record => record.sessionId === normalSession)
  assert.ok(normalRecord, 'canonical managed record missing for the successful remote run')
  assert.equal(normalRecord.provider.id, 'codex')
  assert.ok(normalRecord.tools.value?.length > 0, 'canonical record lacks fixture tool evidence')
  return { records, scryEntries }
}
