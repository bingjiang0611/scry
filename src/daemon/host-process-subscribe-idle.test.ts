import 'reflect-metadata'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { DesktopRemoteClient } from '../main/remote/desktop-client'
import { decrypt, encrypt, ssh } from '../main/remote/desktop-client-fixtures'
import { connectDesktopLane } from '../main/remote/desktop-lane'
import { faultyLaneConnector } from '../main/remote/desktop-lane-fixtures'
import { parseInvitation } from '../main/remote/desktop-client-validation'
import { desktopTlsRequest } from '../main/remote/desktop-transport'
import { createDaemonHostProcess } from './host-process'
import { cleanupTempDirs, MemoryOutputStore, tempDir } from './host-process.fixtures'

it('keeps a connected desktop session idle for 60 seconds with fewer than ten run RPCs', async () => {
  const userDataDir = tempDir()
  const cwd = realpathSync(tempDir())
  const externalSessionId = 'idle-session'
  writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([cwd]))
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([
    { sessionId: externalSessionId, providerId: 'codex', cwd, preview: 'Idle session', ts: Date.now() }
  ]))
  const host = await createDaemonHostProcess({
    userDataDir, daemonStateDirectory: tempDir(), appPath: process.cwd(), resourcesPath: tempDir(),
    appVersion: '0.2.250', isPackaged: false, createOutputStore: () => new MemoryOutputStore()
  })
  let client: DesktopRemoteClient | undefined
  try {
    const invitation = await host.service.beginDesktopPairing()
    const status = host.service.desktopStatus()
    if (!status.enabled) throw new Error('desktop listener did not enable')
    const requests: Record<string, unknown>[] = []
    client = new DesktopRemoteClient({ directory: tempDir(), encrypt, decrypt }, {
      openTunnel: async ({ pairPort, runPort }) => ({
        pairPath: String(pairPort), runPath: String(runPort), alive: true, close: async () => {}
      }),
      tlsRequest: (options) => desktopTlsRequest({
        ...options, path: undefined, host: '127.0.0.1', port: Number(options.path)
      }),
      openLane: faultyLaneConnector(endpoint => connectDesktopLane({
        ...endpoint, path: undefined, host: '127.0.0.1', port: Number(endpoint.path)
      }), frame => { requests.push(frame); return 'deliver' })
    })
    const pending = await client.pair({ label: 'W18 idle desktop', ssh, invitation })
    await host.service.authority.confirmLocal(parseInvitation(invitation).pairingId, pending.publicKeySHA256)
    const id = pending.connection.id
    await client.finishPairing(id)
    await client.connect(id)
    const catalog = await client.catalog(id)
    expect(catalog.sessions.some(row => row.externalSessionId === externalSessionId)).toBe(true)
    await client.setViewedSession(id, { providerId: 'codex', cwd, externalSessionId })
    await expect.poll(() => requests.some(frame => frame.op === 'subscribe' &&
      Array.isArray(frame.views) && frame.views.includes('detail') && frame.known !== undefined)).toBe(true)
    const start = performance.now()
    const first = requests.length
    await delay(60_000)
    const measured = requests.slice(first)
    console.info('W18 desktop idle RPCs', JSON.stringify({
      elapsedMs: Math.floor(performance.now() - start),
      requests: measured.map(({ op, views }) => ({ op, views }))
    }))
    expect(performance.now() - start).toBeGreaterThanOrEqual(60_000)
    expect(measured.length).toBeLessThan(10)
    expect(measured.every(frame => frame.op === 'subscribe')).toBe(true)
    expect(measured.some(frame => Array.isArray(frame.views) && frame.views.includes('detail'))).toBe(true)
    expect(measured.some(frame => Array.isArray(frame.views) && frame.views.includes('activeRuns'))).toBe(true)
  } finally {
    await client?.dispose()
    await host.dispose()
    cleanupTempDirs()
  }
}, 95_000)
