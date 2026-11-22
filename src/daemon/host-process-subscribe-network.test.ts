import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, cleanupTempDirs, tempDir } from './host-process.fixtures'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'
import { REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'

const savedMode = process.env.SCRY_ORCHESTRATION
afterEach(() => {
  if (savedMode === undefined) delete process.env.SCRY_ORCHESTRATION
  else process.env.SCRY_ORCHESTRATION = savedMode
  cleanupTempDirs()
})

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
  return JSON.parse(buffer.split('\n')[0]) as Record<string, unknown>
}

describe('subscribe is never exposed on the network endpoint', () => {
  it('a paired remote desktop gets unsupported_op in on mode', async () => {
    process.env.SCRY_ORCHESTRATION = 'on'
    const userDataDir = tempDir()
    const workspace = realpathSync(tempDir())
    writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([workspace]))
    const host = await createDaemonHostProcess({
      userDataDir,
      daemonStateDirectory: tempDir(),
      appPath: process.cwd(),
      resourcesPath: tempDir(),
      appVersion: '0.2.250',
      isPackaged: false,
      createOutputStore: () => new MemoryOutputStore()
    })
    try {
      await host.service.beginDesktopPairing()
      const status = host.service.desktopStatus()
      if (!status.enabled) throw new Error('desktop listener did not enable')
      const id = await generateDesktopDeviceIdentity()
      const { pairingId, secret } = await host.service.authority.begin()
      await host.service.authority.prove({ pairingId, secret, csrPEM: id.csrPEM, deviceLabel: 'Mac2 subscribe' }, id.publicKeySHA256)
      const grant = await host.service.authority.confirmLocal(pairingId, id.publicKeySHA256)
      const reply = await callTcp(status.runPort, host.service.caCertificatePEM, grant.certificatePEM, id.keyPEM, {
        op: 'subscribe', views: ['activeRuns'], waitMs: 0
      })
      expect(reply).toEqual({ error: 'unsupported_op' })
      const info = await callTcp(status.runPort, host.service.caCertificatePEM, grant.certificatePEM, id.keyPEM, {
        op: 'desktop', query: { kind: 'info' }
      })
      expect(info.error).toBeUndefined()
    } finally {
      await host.dispose()
    }
  }, 30_000)
})
