import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tlsRequest } from './harness.mjs'

// Real host filesystem, Git and PTY work over the device channel.
export async function verifyWorkbench({ transport, invitation, identity, deviceCertPEM, canonicalWorkspace, workspace, git }) {
  // Real production desktop operations: temporary host filesystem, Git and PTY.
  const workbench = async (surface, method, args, cwd = canonicalWorkspace) => {
    const result = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktopWorkbench', query: { surface, cwd, method, args } })
    assert.equal(result.error, undefined, JSON.stringify(result))
    return result.workbench
  }
  const originalFile = await workbench('workspace', 'workspaceRead', [{ cwd: canonicalWorkspace, path: 'README.md' }])
  await workbench('workspace', 'workspaceWrite', [{ cwd: canonicalWorkspace, path: 'README.md', content: '# remote workbench verified\n', expectedRevision: originalFile.revision }])
  assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), '# remote workbench verified\n')
  const stale = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktopWorkbench', query: { surface: 'workspace', cwd: canonicalWorkspace, method: 'workspaceWrite', args: [{ cwd: canonicalWorkspace, path: 'README.md', content: 'must not write', expectedRevision: originalFile.revision }] } })
  assert.ok(stale.error, 'stale file revision must reject')
  await workbench('workspace', 'workspaceCreate', [{ cwd: canonicalWorkspace, name: 'created.txt', kind: 'file' }])
  await workbench('workspace', 'workspaceRename', [{ cwd: canonicalWorkspace, path: 'created.txt', name: 'renamed.txt' }])
  assert.ok(existsSync(join(workspace, 'renamed.txt')))
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false')
  const scm = await workbench('sourceControl', 'read', [canonicalWorkspace])
  assert.equal(scm.status, 'available')
  const staged = await workbench('sourceControl', 'mutate', [{ repositoryId: scm.data.id, expectedRevision: scm.data.revision, action: 'stage', paths: ['README.md'], operationId: randomUUID() }])
  assert.equal(staged.status, 'succeeded', JSON.stringify(staged))
  const stagedSnapshot = await workbench('sourceControl', 'read', [canonicalWorkspace])
  const committed = await workbench('sourceControl', 'mutate', [{ repositoryId: scm.data.id, expectedRevision: stagedSnapshot.data.revision, action: 'commit', message: 'Verify remote workbench', operationId: randomUUID() }])
  assert.equal(committed.status, 'succeeded', JSON.stringify(committed))
  assert.equal(git('log', '-1', '--format=%s').toString().trim(), 'Verify remote workbench')
  const shell = await workbench('terminal', 'terminalStart', [{ cwd: canonicalWorkspace, cols: 100, rows: 30, scopeId: 'real-remote-workbench' }])
  assert.equal(shell.cwd, canonicalWorkspace)
  await workbench('terminal', 'terminalReady', [shell.id, shell.ownershipEpoch])
  await workbench('terminal', 'terminalWrite', [shell.id, shell.ownershipEpoch, "printf 'remote-native-terminal\\n' > terminal-marker.txt; pwd\r"])
  let cursor, output = '', acknowledged = 0
  const terminalDeadline = Date.now() + 15000
  while (Date.now() < terminalDeadline && (!existsSync(join(workspace, 'terminal-marker.txt')) || !output.includes(canonicalWorkspace))) {
    const events = await workbench('terminal', 'terminalEvents', cursor ? [cursor] : [])
    cursor = events.cursor
    for (const event of events.events) if (event.kind === 'data') for (const data of event.events) {
      output += data.data; acknowledged += Buffer.byteLength(data.data)
      await workbench('terminal', 'terminalAck', [shell.id, shell.ownershipEpoch, acknowledged])
      await workbench('terminal', 'terminalAck', [shell.id, shell.ownershipEpoch, acknowledged])
    }
    if (!existsSync(join(workspace, 'terminal-marker.txt'))) await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(readFileSync(join(workspace, 'terminal-marker.txt'), 'utf8'), 'remote-native-terminal\n')
  assert.ok(output.includes(canonicalWorkspace), 'PTY must execute pwd in the host workspace')
  await workbench('terminal', 'terminalWrite', [shell.id, shell.ownershipEpoch, "/usr/bin/yes remote-output | /usr/bin/head -c 1100000; printf detached > detached-marker.txt\r"])
  await workbench('terminal', 'terminalDetach', [shell.id, shell.ownershipEpoch])
  const detachedDeadline = Date.now() + 15000
  while (Date.now() < detachedDeadline && !existsSync(join(workspace, 'detached-marker.txt'))) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(readFileSync(join(workspace, 'detached-marker.txt'), 'utf8'), 'detached', 'background PTY must not stall after detaching its consumer')
  const attached = await workbench('terminal', 'terminalAttach', [shell.id])
  assert.ok(attached.ownershipEpoch > shell.ownershipEpoch)
  assert.ok(attached.catchUp.endOffset > 0)
  const staleInput = await tlsRequest(transport, invitation.runPort, invitation.anchorPEM, deviceCertPEM, identity.keyPEM, { op: 'desktopWorkbench', query: { surface: 'terminal', cwd: canonicalWorkspace, method: 'terminalWrite', args: [shell.id, shell.ownershipEpoch, 'must-not-execute\r'] } })
  assert.equal(staleInput.error, 'stale_terminal_owner')
  await workbench('terminal', 'terminalClose', [shell.id, attached.ownershipEpoch])
}
