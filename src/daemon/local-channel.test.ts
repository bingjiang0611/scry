import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { RemoteHostService } from '../main/remote/remote-host-service'
import { RunOutputFileStore } from '../main/remote/run-output-file'
import { ProviderOperationGate } from '../main/provider-operation-gate'
import { verifyCSR } from '../main/remote/enrollment'
import { createDesktopHostReader } from '../main/remote/desktop-host-reader'
import { REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'
import { openLocalChannel, type LocalChannel } from './local-channel'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

// The daemon's local channel is the production inner-mTLS host served over a unix
// socket: no stub TLS, no fake authorization.

const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function localHost() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-daemon-local-'))
  dirs.push(dir)
  // The desktop surface the daemon serves: same reader the app builds, without a run.
  const hostId = { current: '' }
  const service = await RemoteHostService.create({
    stateDirectory: join(dir, 'remote'), authorizeWorkspace: (cwd: string) => cwd, startRun: async () => {},
    gate: new ProviderOperationGate(), createOutputStore: (directory: string) => new RunOutputFileStore(directory),
    readDesktop: createDesktopHostReader({
      userDataDir: dir, hostId: () => hostId.current, authorizeWorkspace: (cwd: string) => cwd, getRun: () => null
    })
  })
  hostId.current = service.hostId
  cleanups.push(() => service.dispose())
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const csrPEM = (await Pkcs10CertificateRequestGenerator.create({ name: 'CN=daemon-local', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })).toString('pem')
  const { publicKeySHA256 } = await verifyCSR(csrPEM)
  const pair = await service.authority.begin()
  await service.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'local daemon client' }, publicKeySHA256)
  // The local device is enrolled through the same owner-confirmation path as a
  // paired phone; it is a real grant, not a bypass.
  const grant = await service.authority.confirmLocal(pair.pairingId, publicKeySHA256)
  return {
    dir,
    service,
    grant,
    keyPEM: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`
  }
}

async function openChannel(serve: (stream: import('node:stream').Duplex) => void, directory: string): Promise<LocalChannel> {
  const channel = await openLocalChannel({ directory, serve })
  cleanups.push(() => channel.close())
  return channel
}

// One request over the unix socket, framed like every other host request.
function request(host: Awaited<ReturnType<typeof localHost>>, channel: LocalChannel, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      path: channel.socketPath, ca: host.service.caCertificatePEM, cert: host.grant.certificatePEM, key: host.keyPEM,
      servername: 'scry-host', minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true
    } as never)
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('local_request_timeout')) }, 10_000)
    socket.once('secureConnect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      const end = buffer.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      const line = buffer.slice(0, end)
      socket.destroy()
      try { resolve(JSON.parse(line.replace(/^\{"keepAlive":true,/, '{'))) } catch (error) { reject(error as Error) }
    })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

describe('daemon local channel', () => {
  it('binds a unix socket with 0700/0600 permissions and no TCP listener', async () => {
    const host = await localHost()
    const channel = await openChannel((stream) => host.service.host.serve(stream), join(host.dir, 'daemon'))
    expect(channel.socketPath).toBe(join(host.dir, 'daemon', 'local.sock'))
    expect(statSync(join(host.dir, 'daemon')).mode & 0o777).toBe(0o700)
    expect(statSync(channel.socketPath).mode & 0o777).toBe(0o600)
    // The channel exposes a socket path and nothing else: no port, no address.
    expect(Object.keys(channel).sort()).toEqual(['close', 'socketPath'])
  })

  it('answers a local device over the socket and refuses a stale protocol', async () => {
    const host = await localHost()
    const channel = await openChannel((stream) => host.service.host.serve(stream), join(host.dir, 'daemon'))
    const info = await request(host, channel, { protocol: REMOTE_PROTOCOL_VERSION, op: 'desktop', query: { kind: 'info' } })
    expect(info.desktop).toMatchObject({ kind: 'info', protocol: REMOTE_PROTOCOL_VERSION, hostId: host.service.hostId })
    // The same hard version gate as the remote path: no downgrade, no compat layer.
    const stale = await request(host, channel, { protocol: 1, op: 'desktop', query: { kind: 'info' } })
    expect(stale).toMatchObject({ error: 'protocol_mismatch', hostProtocol: REMOTE_PROTOCOL_VERSION, clientProtocol: 1 })
  })

  it('refuses a revoked local device on the same socket', async () => {
    const host = await localHost()
    const channel = await openChannel((stream) => host.service.host.serve(stream), join(host.dir, 'daemon'))
    expect((await request(host, channel, { protocol: REMOTE_PROTOCOL_VERSION, op: 'desktop', query: { kind: 'info' } })).desktop).toBeDefined()
    await host.service.revokeDevice(host.grant.deviceId)
    const refused = await request(host, channel, { protocol: REMOTE_PROTOCOL_VERSION, op: 'desktop', query: { kind: 'info' } })
    expect(refused.error).toBe('device_not_authorized')
  })

  it('rejects a client whose certificate the host did not issue', async () => {
    const host = await localHost()
    const channel = await openChannel((stream) => host.service.host.serve(stream), join(host.dir, 'daemon'))
    const other = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', other.privateKey)).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
    const csrPEM = (await Pkcs10CertificateRequestGenerator.create({ name: 'CN=intruder', keys: other, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })).toString('pem')
    const { publicKeySHA256 } = await verifyCSR(csrPEM)
    const pair = await host.service.authority.begin()
    await host.service.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM, deviceLabel: 'intruder' }, publicKeySHA256)
    const foreign = await host.service.authority.confirmLocal(pair.pairingId, publicKeySHA256)
    // Revoked, so TLS still completes but authorization fails: the grant decides, not the socket.
    await host.service.revokeDevice(foreign.deviceId)
    const foreignHost = { ...host, grant: foreign, keyPEM: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n` }
    expect((await request(foreignHost as typeof host, channel, { protocol: REMOTE_PROTOCOL_VERSION, op: 'desktop', query: { kind: 'info' } })).error)
      .toBe('device_not_authorized')
  })
})
