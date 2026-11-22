import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { existsSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, tempDir } from './host-process.fixtures'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'
import { REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'


async function enrollLocal(
  service: Awaited<ReturnType<typeof createDaemonHostProcess>>['service'],
  deviceLabel: string
) {
  const id = await generateDesktopDeviceIdentity()
  const grant = await service.enrollLocalDevice({ csrPEM: id.csrPEM, deviceLabel }, () => true)
  return { keyPEM: id.keyPEM, certPEM: grant.certificatePEM, deviceId: grant.deviceId }
}

async function pairRemoteDesktop(service: Awaited<ReturnType<typeof createDaemonHostProcess>>['service']) {
  const id = await generateDesktopDeviceIdentity()
  const { pairingId, secret } = await service.authority.begin()
  await service.authority.prove({ pairingId, secret, csrPEM: id.csrPEM, deviceLabel: 'Mac2 W17' }, id.publicKeySHA256)
  const grant = await service.authority.confirmLocal(pairingId, id.publicKeySHA256)
  return { keyPEM: id.keyPEM, certPEM: grant.certificatePEM, deviceId: grant.deviceId }
}

async function openKeepAliveSocket(socketPath: string, ca: string, cert: string, key: string) {
  const raw = netConnect(socketPath)
  await once(raw, 'connect')
  const socket: TLSSocket = tlsConnect({
    socket: raw, ca, cert, key,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
  })
  await once(socket, 'secureConnect')
  let buffer = ''
  const waiters: Array<(line: string) => void> = []
  const lines: string[] = []
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\n')) {
      const idx = buffer.indexOf('\n')
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else lines.push(line)
    }
  })
  const nextLine = () => lines.length > 0
    ? Promise.resolve(lines.shift()!)
    : new Promise<string>((resolve, reject) => {
      const onEnd = () => reject(new Error('socket_closed'))
      socket.once('close', onEnd)
      waiters.push((line) => { socket.off('close', onEnd); resolve(line) })
    })
  return {
    socket,
    async request(req: Record<string, unknown>) {
      socket.write(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, keepAlive: true, ...req })}\n`)
      return JSON.parse(await nextLine()) as Record<string, any>
    },
    destroy() { socket.destroy() }
  }
}

async function callTcp(port: number, ca: string, cert: string, key: string, request: Record<string, unknown>) {
  const socket: TLSSocket = tlsConnect({
    host: '127.0.0.1', port, ca, cert, key,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
  })
  await once(socket, 'secureConnect')
  socket.write(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...request })}\n`)
  let buffer = ''
  for await (const chunk of socket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0]) as Record<string, any>
}

describe('daemon remote session actions & bridged workbench shell ops (W17)', () => {
  afterEach(() => cleanupTempDirs())

  async function startFixture() {
    const userDataDir = tempDir()
    const daemonStateDirectory = tempDir()
    const workspace = realpathSync(tempDir())
    const unauthorized = realpathSync(tempDir())
    writeFileSync(join(workspace, 'note.txt'), 'hello w17\n')
    writeFileSync(join(unauthorized, 'secret.txt'), 'nope\n')
    writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([workspace]))
    writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
      sessionId: 'w17-sess-1',
      externalSessionId: 'w17-sess-1',
      runId: 'w17-run-1',
      providerId: 'codex',
      runtimeProvider: 'codex_cli',
      cwd: workspace,
      preview: 'original preview',
      ts: Date.now()
    }]))
    const host = await createDaemonHostProcess({
      userDataDir,
      daemonStateDirectory,
      appPath: process.cwd(),
      resourcesPath: tempDir(),
      appVersion: '0.2.250',
      isPackaged: false,
      createOutputStore: () => new MemoryOutputStore()
    })
    await host.service.beginDesktopPairing()
    const status = host.service.desktopStatus()
    if (!status.enabled) throw new Error('desktop listener did not enable')
    return { host, workspace, unauthorized, runPort: status.runPort, ca: host.service.caCertificatePEM }
  }

  it('declares sessionActions/sessionFork/sessionDelete and enforces remote authorization & archive-only delete', async () => {
    const { host, workspace, unauthorized, runPort, ca } = await startFixture()
    try {
      const peer = await pairRemoteDesktop(host.service)
      const remote = (req: Record<string, unknown>) => callTcp(runPort, ca, peer.certPEM, peer.keyPEM, req)

      const info = await remote({ op: 'desktop', query: { kind: 'info' } })
      expect(info.desktop.sessionActions).toBe(true)
      expect(info.desktop.sessionFork).toBe(true)
      expect(info.desktop.sessionDelete).toBe(true)

      const ctx = { cwd: workspace, providerId: 'codex', externalSessionId: 'w17-sess-1' }

      const renamed = await remote({ op: 'sessionAction', context: ctx, action: { kind: 'rename', title: 'Renamed W17' } })
      expect(renamed.sessionAction).toBe(true)
      const pinned = await remote({ op: 'sessionAction', context: ctx, action: { kind: 'pin', pinned: true } })
      expect(pinned.sessionAction).toBe(true)

      const sessionsAfterPin = await remote({ op: 'sessions' })
      const row = sessionsAfterPin.sessions.find((s: { sessionId: string }) => s.sessionId === 'w17-sess-1')
      expect(row.label).toBe('Renamed W17')
      expect(row.pinnedAt).toBeTypeOf('number')

      const badWorkspace = await remote({
        op: 'sessionAction',
        context: { cwd: unauthorized, providerId: 'codex', externalSessionId: 'w17-sess-1' },
        action: { kind: 'pin', pinned: false }
      })
      expect(badWorkspace.error).toBeTruthy()

      const unconfirmed = await remote({
        op: 'sessionDelete',
        request: { providerId: 'codex', cwd: workspace, externalSessionId: 'w17-sess-1', confirmed: false }
      })
      expect(unconfirmed.error).toBe('invalid_session_delete')

      const unarchived = await remote({
        op: 'sessionDelete',
        request: { providerId: 'codex', cwd: workspace, externalSessionId: 'w17-sess-1', confirmed: true }
      })
      expect(unarchived.error).toContain('远程删除只允许已存档会话')

      const archived = await remote({ op: 'sessionAction', context: ctx, action: { kind: 'archive', archived: true } })
      expect(archived.sessionAction).toBe(true)
      const deleted = await remote({
        op: 'sessionDelete',
        request: { providerId: 'codex', cwd: workspace, externalSessionId: 'w17-sess-1', confirmed: true }
      })
      expect(deleted.error).toBeUndefined()
      expect(deleted.sessionDelete?.ok).toBe(true)

      const badFork = await remote({
        op: 'sessionFork',
        request: {
          providerId: 'codex', cwd: unauthorized, sourceSessionId: 's', sourceRunId: 'r',
          sourceProviderTurnId: 't', sourceForkTurnId: 'f'
        }
      })
      expect(badFork.error).toBeTruthy()
      expect(badFork.error).not.toBe('desktop_session_fork_unsupported')

      await host.service.revokeDevice(peer.deviceId)
      const revoked = await remote({ op: 'sessionAction', context: ctx, action: { kind: 'pin', pinned: false } })
      expect(revoked.error).toBe('device_not_authorized')
    } finally {
      await host.dispose()
    }
  }, 30_000)

  it('bridges openPath & trashItem via primary App only, and reports honest absence when App is disconnected', async () => {
    const { host, workspace, runPort, ca } = await startFixture()
    const opened: string[] = []
    const trashed: string[] = []
    let appSock: Awaited<ReturnType<typeof openKeepAliveSocket>> | undefined
    try {
      const peer = await pairRemoteDesktop(host.service)
      const remote = (req: Record<string, unknown>) => callTcp(runPort, ca, peer.certPEM, peer.keyPEM, req)

      const absentInfo = await remote({ op: 'desktop', query: { kind: 'info' } })
      expect(absentInfo.desktop.workbenchOps).toEqual({ openPath: false, trashItem: false })
      const absentOpen = await remote({
        op: 'desktopWorkbench',
        query: { surface: 'workspace', cwd: workspace, method: 'workspaceOpenExternal', args: [{ cwd: workspace, path: 'note.txt' }] }
      })
      expect(absentOpen.error).toBe('desktop_workbench_operation_unavailable:openPath')
      const absentTrash = await remote({
        op: 'desktopWorkbench',
        query: { surface: 'workspace', cwd: workspace, method: 'workspaceTrash', args: [{ cwd: workspace, path: 'note.txt' }] }
      })
      expect(absentTrash.error).toBe('desktop_workbench_operation_unavailable:trashItem')
      expect(existsSync(join(workspace, 'note.txt'))).toBe(true)

      const nonPrimary = await enrollLocal(host.service, 'non-primary-helper')
      const hijacked = await call(host.channel.socketPath, ca, nonPrimary.certPEM, nonPrimary.keyPEM, {
        op: 'executionTargetWork', waitMs: 50
      })
      expect(hijacked.error).toBe('execution_target_bridge_unauthorized')
      expect((await remote({ op: 'desktop', query: { kind: 'info' } })).desktop.workbenchOps).toEqual({ openPath: false, trashItem: false })

      const appPeer = await enrollLocal(host.service, 'Scry App')
      appSock = await openKeepAliveSocket(host.channel.socketPath, ca, appPeer.certPEM, appPeer.keyPEM)
      let pollLoop = appSock.request({ op: 'executionTargetWork', waitMs: 15_000 })
      await new Promise((r) => setTimeout(r, 80))

      const liveInfo = await remote({ op: 'desktop', query: { kind: 'info' } })
      expect(liveInfo.desktop.workbench).toBe(1)
      expect(liveInfo.desktop.workbenchOps).toBeUndefined()

      const openPromise = remote({
        op: 'desktopWorkbench',
        query: { surface: 'workspace', cwd: workspace, method: 'workspaceOpenExternal', args: [{ cwd: workspace, path: 'note.txt' }] }
      })
      const batch1 = await pollLoop
      expect(batch1.calls).toHaveLength(1)
      expect(batch1.calls[0].method).toBe('shellOpenPath')
      expect(batch1.calls[0].input).toEqual({ path: join(workspace, 'note.txt') })
      opened.push(batch1.calls[0].input.path)
      await appSock.request({ op: 'executionTargetResult', callId: batch1.calls[0].callId, ok: true, result: null })
      const openReply = await openPromise
      expect(openReply.error).toBeUndefined()
      expect(opened).toEqual([join(workspace, 'note.txt')])

      const escapeReply = await remote({
        op: 'desktopWorkbench',
        query: { surface: 'workspace', cwd: workspace, method: 'workspaceTrash', args: [{ cwd: workspace, path: '../escape.txt' }] }
      })
      expect(escapeReply.error).toBeTruthy()
      expect(trashed).toEqual([])

      pollLoop = appSock.request({ op: 'executionTargetWork', waitMs: 15_000 })
      await new Promise((r) => setTimeout(r, 50))
      const trashPromise = remote({
        op: 'desktopWorkbench',
        query: { surface: 'workspace', cwd: workspace, method: 'workspaceTrash', args: [{ cwd: workspace, path: 'note.txt' }] }
      })
      const batch2 = await pollLoop
      expect(batch2.calls).toHaveLength(1)
      expect(batch2.calls[0].method).toBe('shellTrashItem')
      expect(batch2.calls[0].input).toEqual({ path: join(workspace, 'note.txt') })
      trashed.push(batch2.calls[0].input.path)
      await appSock.request({ op: 'executionTargetResult', callId: batch2.calls[0].callId, ok: true, result: null })
      const trashReply = await trashPromise
      expect(trashReply.error).toBeUndefined()
      expect(trashed).toEqual([join(workspace, 'note.txt')])

      appSock.destroy()
      appSock = undefined
      await new Promise((r) => setTimeout(r, 80))
      const disconnectedInfo = await remote({ op: 'desktop', query: { kind: 'info' } })
      expect(disconnectedInfo.desktop.workbenchOps).toEqual({ openPath: false, trashItem: false })
      const afterDisconnect = await remote({
        op: 'desktopWorkbench',
        query: { surface: 'workspace', cwd: workspace, method: 'workspaceOpenExternal', args: [{ cwd: workspace, path: 'note.txt' }] }
      })
      expect(afterDisconnect.error).toBe('desktop_workbench_operation_unavailable:openPath')
    } finally {
      appSock?.destroy()
      await host.dispose()
    }
  }, 30_000)

  it('rejects workspace escapes in the daemon before anything reaches the App bridge', async () => {
    const { host, workspace, unauthorized, runPort, ca } = await startFixture()
    symlinkSync(join(unauthorized, 'secret.txt'), join(workspace, 'link-out'))
    let appSock: Awaited<ReturnType<typeof openKeepAliveSocket>> | undefined
    try {
      const peer = await pairRemoteDesktop(host.service)
      const remote = (req: Record<string, unknown>) => callTcp(runPort, ca, peer.certPEM, peer.keyPEM, req)
      const appPeer = await enrollLocal(host.service, 'Scry App')
      appSock = await openKeepAliveSocket(host.channel.socketPath, ca, appPeer.certPEM, appPeer.keyPEM)
      const poll = appSock.request({ op: 'executionTargetWork', waitMs: 1_500 })
      await new Promise((r) => setTimeout(r, 80))
      const cases: Array<[string, string, string]> = [
        ['workspaceTrash', '../escape.txt', '工作区路径不能越过根目录'],
        ['workspaceOpenExternal', '../escape.txt', '工作区路径不能越过根目录'],
        ['workspaceTrash', 'link-out', '符号链接目标不能越过工作区'],
        ['workspaceOpenExternal', 'link-out', '符号链接目标不能越过工作区']
      ]
      for (const [method, path, message] of cases) {
        const reply = await remote({
          op: 'desktopWorkbench',
          query: { surface: 'workspace', cwd: workspace, method, args: [{ cwd: workspace, path }] }
        })
        expect(String(reply.error), `${method} ${path}`).toContain(message)
      }
      const batch = await poll
      expect(batch.calls ?? []).toEqual([])
      expect(existsSync(join(unauthorized, 'secret.txt'))).toBe(true)
    } finally {
      appSock?.destroy()
      await host.dispose()
    }
  }, 30_000)
})
