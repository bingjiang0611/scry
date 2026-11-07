import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { createDaemonHostProcess } from './host-process'
import type { OutputChunk, RunOutputStore } from '../main/remote/run-output-log'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { createRecentFoldersStore } from '../main/app-store'
import { REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-daemon-host-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class MemoryOutputStore implements RunOutputStore {
  private readonly chunks: OutputChunk[] = []
  append(chunk: Omit<OutputChunk, 'seq'>): OutputChunk {
    const next = { ...chunk, seq: (this.chunks.at(-1)?.seq ?? 0) + 1 }
    this.chunks.push(next)
    return next
  }
  since(runId: string, cursor: number) {
    const chunks = this.chunks.filter((chunk) => chunk.runId === runId && chunk.seq > cursor)
    return { chunks, cursor: chunks.at(-1)?.seq ?? cursor }
  }
  close(): void {}
}

// local.sock serves the App's own grant only. A device grant is refused there by the
// transport rule, so the fixture enrolls the way the App does: present the 0600
// enrollment secret over the enrollment socket.
async function enrollLocal(service: Awaited<ReturnType<typeof createDaemonHostProcess>>['service']) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const keyPEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=daemon-device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  const csrPEM = csr.toString('pem')
  const grant = await service.enrollLocalDevice({ csrPEM, deviceLabel: 'daemon fixture' }, () => true)
  return { keyPEM, certPEM: grant.certificatePEM }
}

async function call(socketPath: string, ca: string, cert: string, key: string, request: Record<string, unknown>) {
  const raw: Socket = netConnect(socketPath)
  await once(raw, 'connect')
  const socket: TLSSocket = tlsConnect({ socket: raw, ca, cert, key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
  await once(socket, 'secureConnect')
  socket.write(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...request })}\n`)
  let buffer = ''
  for await (const chunk of socket) { buffer += (chunk as Buffer).toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0]) as Record<string, any>
}

describe('daemon host process', () => {
  it('fails before serving when a packaged daemon has no private recorder CLI', async () => {
    const root = tempDir()
    await expect(createDaemonHostProcess({
      userDataDir: join(root, 'userData'),
      daemonStateDirectory: join(root, 'state'),
      appPath: join(root, 'resources', 'app.asar'),
      resourcesPath: join(root, 'resources'),
      appVersion: '9.8.7',
      isPackaged: true
    })).rejects.toThrow('daemon_recorder_cli_unavailable')
    expect(existsSync(join(root, 'state', 'local.sock'))).toBe(false)
  })

  it('assembles the run pipeline and host, serves only a unix socket, and disposes it', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const ledgerDirectory = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
    const ledgerStore = new SessionLedgerFileStore(ledgerDirectory)
    const ledger = new SessionLedger({ store: ledgerStore })
    const orphan = randomUUID()
    ledger.recordIntent({
      intentId: randomUUID(),
      runId: orphan,
      detail: JSON.stringify({ cwd: root, providerId: 'claude', prompt: 'unknown outcome' })
    })
    ledger.markDispatched(orphan)
    ledgerStore.close()

    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { mode: 0o700 })
    createRecentFoldersStore(userDataDir).push(workspace)
    const staleAtomicTemp = join(userDataDir, 'app-sessions.json.tmp')
    writeFileSync(staleAtomicTemp, 'stale', { mode: 0o600 })
    const oldRelay = process.env.SCRY_REMOTE_RELAY_ENABLED
    const oldSmoke = process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    const oldLogging = process.env.ELECTRON_ENABLE_LOGGING
    process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
    process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
    process.env.ELECTRON_ENABLE_LOGGING = '1'
    process.argv.push('--remote-debugging-port=0')
    try {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      expect(host.channel.socketPath).toBe(join(daemonStateDirectory, 'local.sock'))
      expect(existsSync(staleAtomicTemp)).toBe(false)
      expect(existsSync(host.channel.socketPath)).toBe(true)
      expect(host.service.relayConfigured).toBe(false)
      const recovered = readFileSync(join(ledgerDirectory, 'session-ledger.log'), 'utf8')
      expect(recovered).toContain(`\"runId\":\"${orphan}\"`)
      expect(recovered).toContain('run_failed')
      expect(recovered).toContain('host_restarted')

      const device = await enrollLocal(host.service)
      const desktop = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'desktop', query: { kind: 'info' }
      })
      expect(desktop.desktop).not.toHaveProperty('sessionActions')
      expect(desktop.desktop).not.toHaveProperty('sessionFork')
      expect(desktop.desktop).not.toHaveProperty('sessionDelete')
      expect(desktop.desktop.workbenchOps).toEqual({ openPath: false, trashItem: false })
      const providers = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'providers', detail: 'metadata'
      })
      expect(providers.providers.find((provider: { providerId?: string; id?: string }) =>
        (provider.providerId ?? provider.id) === 'codex')).not.toMatchObject({ forkSession: true })

      const intentId = randomUUID()
      const submitted = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit', intentId, detail: JSON.stringify({ cwd: workspace, providerId: 'codex', prompt: 'daemon parity' })
      })
      expect(submitted.status).toBe('recorded')
      const runId = submitted.runId as string
      let cursor = 0
      let outputCursor = 0
      const events: Array<{ kind: string }> = []
      const chunks: unknown[] = []
      let state = 'dispatched'
      for (let attempt = 0; attempt < 10 && state === 'dispatched'; attempt += 1) {
        const watched = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'watch', runId, cursor, outputCursor, waitMs: 5_000
        })
        state = watched.watch.state
        cursor = watched.watch.poll.cursor
        outputCursor = watched.watch.output.cursor
        events.push(...watched.watch.poll.events)
        chunks.push(...watched.watch.output.chunks)
      }
      expect(state).toBe('settled')
      expect(events.some((event) => event.kind === 'run_settled')).toBe(true)
      expect(chunks.length).toBeGreaterThan(0)
      await host.dispose()
      expect(existsSync(host.channel.socketPath)).toBe(false)
    } finally {
      process.argv.splice(process.argv.indexOf('--remote-debugging-port=0'), 1)
      if (oldRelay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
      else process.env.SCRY_REMOTE_RELAY_ENABLED = oldRelay
      if (oldSmoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
      else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = oldSmoke
      if (oldLogging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
      else process.env.ELECTRON_ENABLE_LOGGING = oldLogging
    }
  }, 30_000)
})
