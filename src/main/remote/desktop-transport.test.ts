import 'reflect-metadata'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { ensureHostIdentity, type HostIdentity } from './host-identity'
import { desktopTlsRequest, generateDesktopDeviceIdentity, openDesktopSshTunnel } from './desktop-transport'

type FakeChild = EventEmitter & {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: (signal?: NodeJS.Signals) => boolean
}

const directories: string[] = []
const servers: Array<TlsServer | NetServer> = []
const sockets: TLSSocket[] = []
afterEach(async () => {
  spawnMock.mockReset()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function identityFixture(): Promise<{ identity: HostIdentity; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'scry-desktop-test-'))
  directories.push(directory)
  return { identity: await ensureHostIdentity(join(directory, 'identity')), directory }
}

async function deviceFixture(identity: HostIdentity) {
  const device = await generateDesktopDeviceIdentity()
  const verified = await identity.verifyCSR(device.csrPEM)
  const issued = await identity.issue({ ...verified, deviceId: randomUUID() })
  return { ...device, certPEM: issued.certificatePEM, fingerprint: digest(issued.certificatePEM) }
}

function digest(certificatePEM: string): string {
  const match = certificatePEM.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/)
  if (!match) throw new Error('certificate_fixture_invalid')
  return createHash('sha256').update(Buffer.from(match[1].replace(/\s/g, ''), 'base64')).digest('hex')
}

async function tlsFixture(identity: HostIdentity, behavior: (fingerprint: string) => unknown, options: { respond?: boolean; delayMs?: number } = {}) {
  const serverCredentials = await identity.issueHostServer()
  const revoked = new Set<string>()
  const server = createTlsServer({ allowHalfOpen: options.delayMs !== undefined, key: serverCredentials.privateKeyPEM,
    cert: serverCredentials.certificatePEM,
    ca: identity.caCertificatePEM,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3'
  }, (socket) => {
    sockets.push(socket)
    socket.once('data', () => {
      if (options.respond === false) return
      const peer = socket.getPeerCertificate()
      const fingerprint = peer.raw ? createHash('sha256').update(peer.raw).digest('hex') : ''
      const reply = JSON.stringify(behavior(fingerprint)) + '\n'
      if (options.delayMs) setTimeout(() => socket.end(reply), options.delayMs)
      else socket.end(reply)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('tls_fixture_not_listening')
  return { server, port: address.port, revoked }
}

describe('desktop transport', () => {
  it('generates a P-256 CSR, bootstrap client certificate, and stable public-key digest', async () => {
    const identity = await generateDesktopDeviceIdentity()
    expect(identity.keyPEM).toContain('BEGIN PRIVATE KEY')
    expect(identity.csrPEM).toContain('BEGIN CERTIFICATE REQUEST')
    expect(identity.bootstrapCertPEM).toContain('BEGIN CERTIFICATE')
    expect(identity.publicKeySHA256).toMatch(/^[0-9a-f]{64}$/)
    const verified = await (await identityFixture()).identity.verifyCSR(identity.csrPEM)
    expect(verified.publicKeySHA256).toBe(identity.publicKeySHA256)
  })

  it('uses standard TLS 1.3 chain and logical-name verification, rejecting a wrong pin', async () => {
    const { identity } = await identityFixture()
    const device = await deviceFixture(identity)
    const fixture = await tlsFixture(identity, () => ({ ok: true }))
    await expect(desktopTlsRequest({ host: '127.0.0.1', port: fixture.port, caPEM: identity.caCertificatePEM, certPEM: device.certPEM, keyPEM: device.keyPEM, request: { op: 'poll' } })).resolves.toEqual({ ok: true })
    const wrong = await identityFixture()
    await expect(desktopTlsRequest({ host: '127.0.0.1', port: fixture.port, caPEM: wrong.identity.caCertificatePEM, certPEM: device.certPEM, keyPEM: device.keyPEM, request: {} })).rejects.toBeTruthy()
  })

  it('keeps bootstrap and revoked certificates out of authorized responses', async () => {
    const { identity } = await identityFixture()
    const device = await deviceFixture(identity)
    const fixture = await tlsFixture(identity, (fingerprint) => fixture.revoked.has(fingerprint) ? { error: 'device_not_authorized' } : { ok: true })
    expect(await desktopTlsRequest({ host: '127.0.0.1', port: fixture.port, caPEM: identity.caCertificatePEM, certPEM: device.certPEM, keyPEM: device.keyPEM, request: {} })).toEqual({ ok: true })
    fixture.revoked.add(device.fingerprint)
    await expect(desktopTlsRequest({ host: '127.0.0.1', port: fixture.port, caPEM: identity.caCertificatePEM, certPEM: device.certPEM, keyPEM: device.keyPEM, request: {} })).resolves.toEqual({ error: 'device_not_authorized' })
    const bootstrap = await generateDesktopDeviceIdentity()
    await expect(desktopTlsRequest({ host: '127.0.0.1', port: fixture.port, caPEM: identity.caCertificatePEM, certPEM: bootstrap.bootstrapCertPEM, keyPEM: bootstrap.keyPEM, request: {} })).rejects.toBeTruthy()
  })

  it('bounds response bytes, deadlines, and abort cleanup', async () => {
    const { identity } = await identityFixture()
    const device = await deviceFixture(identity)
    // Desktop structured evidence has a 4 MiB response contract; retain the
    // negative boundary check above that limit (requests still use 1.25 MiB).
    const large = await tlsFixture(identity, () => 'x'.repeat(4 * 1024 * 1024 + 1))
    await expect(desktopTlsRequest({ host: '127.0.0.1', port: large.port, caPEM: identity.caCertificatePEM, certPEM: device.certPEM, keyPEM: device.keyPEM, request: {}, timeoutMs: 2_000 })).rejects.toThrow('response_too_large')
    const silent = await tlsFixture(identity, () => ({ delayed: true }), { delayMs: 1_000 })
    await expect(desktopTlsRequest({ host: '127.0.0.1', port: silent.port, caPEM: identity.caCertificatePEM, certPEM: device.certPEM, keyPEM: device.keyPEM, request: {}, timeoutMs: 25 })).rejects.toThrow('timeout')
    const controller = new AbortController()
    const pending = desktopTlsRequest({ host: '127.0.0.1', port: silent.port, caPEM: identity.caCertificatePEM, certPEM: device.certPEM, keyPEM: device.keyPEM, request: {}, signal: controller.signal, timeoutMs: 2_000 })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('spawns one strict no-command SSH tunnel and cleans its private socket directory', async () => {
    let child: FakeChild | undefined
    let socketServers: NetServer[] = []
    spawnMock.mockImplementation((_program: string, args: string[]) => {
      child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as FakeChild
      child.kill = () => {
        child!.signalCode = 'SIGTERM'
        for (const server of socketServers) server.close()
        child!.emit('exit', null, 'SIGTERM')
        return true
      }
      const forwards = args.reduce<string[]>((all, value, index) => value === '-L' ? [...all, args[index + 1]] : all, [])
      socketServers = forwards.map((forward) => {
        const socketPath = forward.slice(0, forward.lastIndexOf(':127.0.0.1:'))
        const server = createNetServer()
        void new Promise<void>((resolve) => server.listen(socketPath, resolve)).then(() => child?.emit('spawn'))
        return server
      })
      return child
    })
    const tunnel = await openDesktopSshTunnel({ username: 'alice', hostname: 'host.example', port: 22, pairPort: 41001, runPort: 41002 })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [program, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(program).toBe('/usr/bin/ssh')
    expect(args).toEqual(expect.arrayContaining(['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ExitOnForwardFailure=yes', '-p', '22', '-N', '-T']))
    expect(args).toContain(`${tunnel.pairPath}:127.0.0.1:41001`)
    expect(args).toContain(`${tunnel.runPath}:127.0.0.1:41002`)
    const directory = join(tunnel.pairPath, '..')
    expect(tunnel.alive).toBe(true)
    child!.kill()
    expect(tunnel.alive).toBe(false)
    await tunnel.close()
    expect(existsSync(directory)).toBe(false)
  })
})
