import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function runHostSetup({ executable, buildTransportClient, freePort, temp, launch, waitForTarget, connectCdp, setCdp, evaluate, decodeInvitation, tlsRequest }) {
  assert.ok(existsSync(executable), `production Electron executable not found: ${executable}; build/package the app before running this smoke`)
  const transport = await buildTransportClient()
  const cdpPort = await freePort()
  const userDataDir = join(temp, 'userData')
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const canonicalWorkspace = realpathSync(workspace)
  writeFileSync(join(workspace, 'README.md'), '# isolated remote host smoke\n')
  writeFileSync(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'desktop-remote-host-smoke', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: true, hooks: true }
  }))
  mkdirSync(join(workspace, '.scry'), { recursive: true })
  writeFileSync(join(workspace, '.gitignore'), '.scry/\n')
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: workspace, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe'
  })
  git('init', '-q')
  git('add', 'README.md', 'scry.config.json', '.gitignore')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'isolated baseline')
  // The production workspace authorizer intentionally accepts only known projects.
  writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([canonicalWorkspace]))
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId: 'desktop-remote-bootstrap', runId: 'desktop-remote-bootstrap', providerId: 'codex', runtimeProvider: 'codex_cli', cwd: canonicalWorkspace,
    preview: 'desktop remote host smoke', ts: Date.now()
  }]))

  launch(cdpPort, userDataDir, home, workspace)
  const page = await waitForTarget(cdpPort)
  assert.match(page.url, /^file:/, 'production renderer must load from a file URL')
  const cdp = connectCdp(page.webSocketDebuggerUrl)
  setCdp(cdp)
  await cdp.send('Runtime.enable')
  const boundary = await evaluate(`(() => ({ requireType: typeof require, scryType: typeof window.scry, inviteType: typeof window.scry?.remoteDesktopHostInvite }))()`)
  assert.equal(boundary.requireType, 'undefined')
  assert.equal(boundary.scryType, 'object')
  assert.equal(boundary.inviteType, 'function')

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
    kind: 'info', protocol: 1, hostId: invitation.hostId, execution: 'canonical',
    directorySelection: true, workbench: 1, sessionActions: true, sessionFork: true, sessionDelete: true, providerDiscovery: 2, managedWorktrees: 1, traceDelta: 1,
    attachments: { transport: 'chunked', chunkBytes: 262144, maxBytes: 16777216, maxCount: 16, maxTotalBytes: 33554432 }
  })
  const workspaceChoices = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'workspaceChoices', request: { cwd: canonicalWorkspace, kind: 'branches', query: '' } }
  })
  assert.equal(workspaceChoices.desktop.kind, 'workspaceChoices')
  assert.equal(workspaceChoices.desktop.value.status, 'available')
  assert.equal(workspaceChoices.desktop.value.data.root, canonicalWorkspace)
  assert.ok(workspaceChoices.desktop.value.data.repositoryId)
  const branchValidation = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, {
    op: 'desktop', query: { kind: 'validateWorkspaceBranch', request: {
      cwd: canonicalWorkspace, repositoryId: workspaceChoices.desktop.value.data.repositoryId, name: 'remote-smoke'
    } }
  })
  assert.deepEqual(branchValidation.desktop, { kind: 'validateWorkspaceBranch', value: { status: 'available', data: { name: 'remote-smoke' } } })
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

  return { transport, workspace, canonicalWorkspace, userDataDir, page, invitation, identity, deviceCertPEM, info, localGrant, git }
}
