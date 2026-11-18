import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tlsRequest } from './harness.mjs'

// Revocation over a valid TLS connection: local client state cannot short-circuit
// this negative check.
export async function verifyRevocation({ transport, evaluate, sessionAction, sessionContext, localGrant, invitation, identity, deviceCertPEM, userDataDir, temp }) {
  // Receiver revocation is tested after valid TLS; local client state cannot
  // short-circuit this negative check.
  await evaluate(`window.scry.remoteRevokeDevice(${JSON.stringify(localGrant.deviceId)})`)
  const revoked = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktop', query: { kind: 'info' } })
  assert.equal(revoked.error, 'device_not_authorized')
  assert.equal((await sessionAction(sessionContext, { kind: 'rename', title: 'Revoked title' })).error, 'device_not_authorized')
  for (const action of ['list', 'select']) {
    const denied = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktopDirectory', query: { action, path: realpathSync(temp) } })
    assert.equal(denied.error, 'device_not_authorized')
  }
  assert.ok(!JSON.parse(readFileSync(join(userDataDir, 'recent-folders.json'), 'utf8')).includes(realpathSync(temp)), 'revoked selection must not persist a grant')
}
