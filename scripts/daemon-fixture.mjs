// Shared fixture for the daemon acceptance scripts: one isolated state directory, a
// one-time enrollment over enroll.sock, and a frame() helper that speaks the App's own
// protocol over local.sock with real mTLS. Nothing here is the App: it is the narrowest
// client that the daemon will accept, so a passing script proves the daemon side works,
// not that the App's wiring does.
import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'
import { connect as tls } from 'node:tls'
import { webcrypto } from 'node:crypto'
import { once } from 'node:events'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'

cryptoProvider.set(webcrypto)

// Same constant the App sends; imported from source would drag the TS graph in.
export const PROTOCOL = 2

export async function waitForSocket(path, timeoutMs, alive) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (alive && !alive()) throw new Error(`daemon exited before creating ${path}`)
    try {
      const probe = netConnect(path)
      await once(probe, 'connect')
      probe.destroy()
      return true
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function deviceKey() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name: 'CN=scry-acceptance', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }
  })
  return { keyPEM: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, csrPEM: csr.toString('pem') }
}

// The App's own enrollment: one-time secret from the state directory, CSR over enroll.sock.
export async function enrollLocalDevice(stateDirectory, deviceLabel = 'acceptance fixture') {
  const key = await deviceKey()
  const secret = JSON.parse(readFileSync(join(stateDirectory, 'local-enrollment.json'), 'utf8')).secret
  const raw = netConnect(join(stateDirectory, 'enroll.sock'))
  await once(raw, 'connect')
  raw.write(`${JSON.stringify({ version: 1, secret, csrPEM: key.csrPEM, deviceLabel })}\n`)
  let buffer = ''
  for await (const chunk of raw) { buffer += chunk.toString('utf8'); if (buffer.includes('\n')) break }
  raw.destroy()
  const reply = JSON.parse(buffer.split('\n')[0])
  if (typeof reply.certificatePEM !== 'string') throw new Error(`enroll failed: ${JSON.stringify(reply)}`)
  return { cert: reply.certificatePEM, ca: reply.caCertificatePEM, key: key.keyPEM }
}

// One frame over local.sock, exactly the shape DaemonClient sends.
export async function frame(stateDirectory, credentials, request) {
  const raw = netConnect(join(stateDirectory, 'local.sock'))
  await once(raw, 'connect')
  const socket = tls({
    socket: raw, ca: credentials.ca, cert: credentials.cert, key: credentials.key,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', servername: 'scry-host', rejectUnauthorized: true
  })
  await once(socket, 'secureConnect')
  socket.write(`${JSON.stringify({ protocol: PROTOCOL, ...request })}\n`)
  let buffer = ''
  for await (const chunk of socket) { buffer += chunk.toString('utf8'); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0])
}
