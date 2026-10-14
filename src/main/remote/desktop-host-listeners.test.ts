import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import type { Duplex } from 'node:stream'
import { ensureHostIdentity, type HostIdentity } from './host-identity'
import { InnerMtlsHost } from './inner-mtls-host'
import { DesktopHostListeners, type DesktopHostEndpoint } from './desktop-host-listeners'
import type { HostController } from './host-controller'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const listeners: DesktopHostListeners[] = []
afterEach(async () => {
  for (const listener of listeners.splice(0).reverse()) await listener.close()
})

function endpoint(reply: string): DesktopHostEndpoint & { streams: Duplex[] } {
  const streams: Duplex[] = []
  return {
    streams,
    serve(stream) {
      streams.push(stream)
      stream.on('data', () => stream.write(reply))
    }
  }
}

async function connectAndRead(port: number, payload: string): Promise<string> {
  const socket = connect({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  socket.write(payload)
  const [chunk] = await once(socket, 'data')
  socket.destroy()
  return (chunk as Buffer).toString()
}

function privateKeyPEM(pkcs8: ArrayBuffer): string {
  const body = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

async function deviceCertificate(identity: HostIdentity): Promise<{ certPEM: string; keyPEM: string }> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const keyPEM = privateKeyPEM(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=desktop-test', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  const verified = await identity.verifyCSR(csr.toString('pem'))
  const issued = await identity.issue({ ...verified, deviceId: randomUUID() })
  return { certPEM: issued.certificatePEM, keyPEM }
}

describe('DesktopHostListeners', () => {
  it('binds both endpoints to loopback ephemeral ports and forwards bytes', async () => {
    const pair = endpoint('pair-reply')
    const run = endpoint('run-reply')
    const listenersInstance = new DesktopHostListeners({ pair, run })
    listeners.push(listenersInstance)

    const first = await listenersInstance.start()
    expect(first.pairPort).toBeGreaterThan(0)
    expect(first.runPort).toBeGreaterThan(0)
    expect(await connectAndRead(first.pairPort, 'pair')).toBe('pair-reply')
    expect(await connectAndRead(first.runPort, 'run')).toBe('run-reply')
    expect(pair.streams).toHaveLength(1)
    expect(run.streams).toHaveLength(1)
    expect(await listenersInstance.start()).toEqual(first)
  })

  it('does not close or dispose the injected transports when its sockets close', async () => {
    const pair = endpoint('')
    const run = endpoint('')
    const pairServe = vi.spyOn(pair, 'serve')
    const runServe = vi.spyOn(run, 'serve')
    const listenersInstance = new DesktopHostListeners({ pair, run })
    listeners.push(listenersInstance)
    const ports = await listenersInstance.start()

    const socket = connect({ host: '127.0.0.1', port: ports.pairPort })
    await once(socket, 'connect')
    for (let attempt = 0; attempt < 20 && pairServe.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    socket.destroy()
    await once(socket, 'close')
    await listenersInstance.close()

    expect(pairServe).toHaveBeenCalledOnce()
    expect(runServe).not.toHaveBeenCalled()
    await expect(listenersInstance.dispose()).resolves.toBeUndefined()
  })

  it('rejects excess connections per endpoint and destroys idle owned sockets', async () => {
    const pair = endpoint('')
    const run = endpoint('')
    const listenersInstance = new DesktopHostListeners({ pair, run, maxConnectionsPerEndpoint: 1, connectionTimeoutMs: 25 })
    listeners.push(listenersInstance)
    const ports = await listenersInstance.start()

    const first = connect({ host: '127.0.0.1', port: ports.pairPort })
    await once(first, 'connect')
    const second = connect({ host: '127.0.0.1', port: ports.pairPort })
    await once(second, 'connect')
    await once(second, 'close')
    expect(pair.streams).toHaveLength(1)

    await once(first, 'close')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(first.destroyed).toBe(true)
  })

  it('forwards a real inner-mTLS request without closing the shared TLS host', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'scry-desktop-host-listeners-'))
    const identity = await ensureHostIdentity(join(directory, 'identity'))
    const server = await identity.issueHostServer()
    const host = new InnerMtlsHost({
      controller: { listProjects: () => [] } as unknown as HostController,
      serverCertPEM: server.certificatePEM,
      serverKeyPEM: server.privateKeyPEM,
      caPEM: identity.caCertificatePEM
    })
    const pair = endpoint('unused')
    const listenersInstance = new DesktopHostListeners({ pair, run: host })
    listeners.push(listenersInstance)
    try {
      const device = await deviceCertificate(identity)
      const ports = await listenersInstance.start()
      const socket: TLSSocket = tlsConnect({
        host: '127.0.0.1', port: ports.runPort,
        ca: identity.caCertificatePEM, cert: device.certPEM, key: device.keyPEM,
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
      })
      await once(socket, 'secureConnect')
      socket.write('{"op":"projects"}\n')
      let response = ''
      for await (const chunk of socket) {
        response += (chunk as Buffer).toString('utf8')
        if (response.includes('\n')) break
      }
      expect(JSON.parse(response.split('\n')[0])).toEqual({ projects: [] })
      socket.destroy()
      await listenersInstance.close()

      const independentAddress = await host.listen()
      expect(independentAddress.host).toBe('127.0.0.1')
      await host.close()
    } finally {
      await listenersInstance.close()
      await host.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
