import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { decodeInvitation, RUN_PROTOCOL_VERSION, tlsRequest } from './harness.mjs'

// Pairing, the negotiated info reply and the directory-selection authority rules.
export async function pairDevice({ evaluate, transport, temp, userDataDir, workspace, canonicalWorkspace }) {
  const remoteStatus = await evaluate(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = await window.scry.remoteStatus();
      if (status.enabled) return status;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('remote host initialization timed out');
  })()`)
  const initialStatus = await evaluate('window.scry.remoteDesktopHostStatus()')
  assert.equal(initialStatus.enabled, false, 'SSH listener must be explicit opt-in')
  assert.equal(remoteStatus.enabled, true)
  assert.equal(remoteStatus.relayConfigured, false)
  const invitation = decodeInvitation(await evaluate('window.scry.remoteDesktopHostInvite()'))
  const identity = await transport.generateDesktopDeviceIdentity()
  const pairingRequest = {
    protocolMajor: 1, requestId: randomUUID(), operation: 'pair.prove', pairingId: invitation.pairingId,
    secret: invitation.secret, csrPEM: identity.csrPEM, deviceLabel: 'desktop-remote-smoke'
  }
  const pending = await tlsRequest(transport, invitation.pairPort, invitation.anchorPEM, identity.bootstrapCertPEM, identity.keyPEM, pairingRequest)
  assert.equal(pending.kind, 'pair.pending')
  assert.equal(pending.publicKeySHA256, identity.publicKeySHA256)
  const localPending = await evaluate('window.scry.remoteStatus()')
  assert.equal(localPending.pending.length, 1)
  assert.equal(localPending.pending[0].pairingId, invitation.pairingId)
  assert.equal(localPending.pending[0].publicKeySHA256, identity.publicKeySHA256)
  // Only this trusted-local renderer IPC may approve a pairing. The device never
  // receives a confirm/revoke operation over the production receiver.
  const localGrant = await evaluate(`window.scry.remoteConfirmPairing(${JSON.stringify(invitation.pairingId)}, ${JSON.stringify(identity.publicKeySHA256)})`)
  assert.equal(localGrant.revoked, false)
  const granted = await tlsRequest(transport, invitation.pairPort, invitation.anchorPEM, identity.bootstrapCertPEM, identity.keyPEM, {
    protocolMajor: 1, requestId: randomUUID(), operation: 'pair.status', pairingId: invitation.pairingId, secret: invitation.secret
  })
  assert.equal(granted.kind, 'pair.granted')
  const deviceCertPEM = granted.certificatePEM
  const info = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktop', query: { kind: 'info' } })
  assert.deepEqual(info.desktop, {
    kind: 'info', protocol: RUN_PROTOCOL_VERSION, hostId: invitation.hostId, execution: 'canonical',
    directorySelection: true, workbench: 1, sessionActions: true, sessionFork: true, sessionDelete: true, providerDiscovery: 2, traceDelta: 1,
    attachments: { transport: 'chunked', chunkBytes: 262144, maxBytes: 16777216, maxCount: 16, maxTotalBytes: 33554432 }
  })
  // Explicit history scope is an authority claim, not permission to convert
  // an unknown session into a successfully verified empty transcript.
  for (const op of ['history', 'historyPage']) {
    const unknown = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
      op, providerId: 'codex', cwd: canonicalWorkspace, externalSessionId: 'not-in-catalog',
      historyScope: 'session', agentProfileId: null
    })
    assert.equal(unknown.error, 'history_session_not_found', `${op} must reject an invented catalog session`)
  }
  const strictUnknown = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'historyPage', providerId: 'codex', cwd: canonicalWorkspace,
    externalSessionId: 'desktop-remote-bootstrap', agentProfileId: 'unproven-profile'
  })
  assert.equal(strictUnknown.error, 'history_profile_unavailable', 'legacy explicit Profile must not become empty session history')
  const customDirectory = join(temp, 'custom project ')
  mkdirSync(customDirectory)
  const canonicalCustom = realpathSync(customDirectory)
  const browse = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktopDirectory', query: { action: 'list', path: canonicalCustom }
  })
  assert.equal(browse.directory.page.current.path, canonicalCustom)
  assert.deepEqual(browse.directory.page.directories, [])
  assert.deepEqual(JSON.parse(readFileSync(join(userDataDir, 'recent-folders.json'), 'utf8')), [canonicalWorkspace], 'browsing must not create a workspace grant')
  const selected = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktopDirectory', query: { action: 'select', path: canonicalCustom }
  })
  assert.deepEqual(selected.directory, { action: 'select', project: { path: canonicalCustom, label: 'custom project ' } })
  assert.ok(JSON.parse(readFileSync(join(userDataDir, 'recent-folders.json'), 'utf8')).includes(canonicalCustom), 'explicit selection must persist the canonical workspace grant')
  const projects = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'projects' })
  assert.ok(projects.projects.some(project => project.path === canonicalCustom), 'selected project must be offered through the production catalog')
  assert.deepEqual(await evaluate('window.scry.activeRuns()'), [], 'selecting a directory must not start an Agent')
  assert.equal(existsSync(join(canonicalCustom, '.scry')), false, 'selection must not create a turn record')
  return { invitation, identity, localGrant, deviceCertPEM, info, canonicalCustom }
}
