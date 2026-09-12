import assert from 'node:assert/strict'
import { access, writeFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { certificates } from './fixture.mjs'
import { loopbackRelay } from './loopback-relay.mjs'
import { verifyCSR, certificateIssuer } from './enrollment.mjs'
import { decodeWire } from './generated/wire.mjs'

const exec = promisify(execFile)
const packagePath = fileURLToPath(new URL('swift/', import.meta.url))
const { stdout: binPath } = await exec('swift', ['build', '--package-path', packagePath, '--show-bin-path'], { timeout: 30_000 })
const probe = join(binPath.trim(), 'scry-remote-probe')
const generator = join(binPath.trim(), 'scry-enrollment-fixture')
await Promise.all([access(probe, constants.X_OK), access(generator, constants.X_OK)])
const identity = await certificates()
try {
  const generated = await exec(generator, [identity.path('')], { timeout: 15_000, maxBuffer: 1024 * 1024 })
  assert.equal((await stat(identity.path('swift-device.key'))).mode & 0o777, 0o600)
  const csr = await verifyCSR(await identity.read('swift-device.csr'))
  assert.equal(csr.publicKeySHA256, generated.stdout.trim(), 'Swift and Node agree on the standard SPKI SHA-256')
  const issue = await certificateIssuer({ certificatePEM: await identity.read('inner-ca.pem'), privateKeyPEM: await identity.read('inner-ca.key') })
  // This harness explicitly signs test material. It does not simulate a human
  // confirmation or claim there is a persistent owner-device grant.
  const certificate = await issue({ csrPEM: csr.csrPEM, expectedCSRHash: csr.csrSHA256,
    expectedPublicKeySHA256: csr.publicKeySHA256, deviceId: randomUUID() })
  await writeFile(identity.path('swift-device-issued.pem'), certificate.certificatePEM, { mode: 0o600, flag: 'wx' })
  const cases = []
  for (const [name, file, success] of [
    ['self-signed bootstrap is not a business credential', 'swift-device-bootstrap.pem', false],
    ['Swift key + CSR → Node issued certificate → NIOSSL mTLS', 'swift-device-issued.pem', true]
  ]) {
    const sentinel = 'scry-g0-enrollment-' + randomUUID()
    const relay = await loopbackRelay(identity, { sentinel })
    try {
      let output, failure
      try {
        output = await exec(probe, [String(relay.port), identity.path('outer-ca.pem'), identity.path('inner-ca.pem'),
          identity.path(file), identity.path('swift-device.key'), sentinel], { timeout: 15_000, maxBuffer: 1024 * 1024 })
      } catch (error) { failure = error }
      if (success) {
        assert.equal(failure, undefined, failure?.stderr)
        assert.equal(decodeWire('ProbeResponse', JSON.parse(output.stdout)).payload, sentinel)
        assert.equal(relay.stats.requests, 1)
        assert.deepEqual(relay.stats.innerTLS, [{ protocol: 'TLSv1.3', resumed: false }])
      } else {
        assert.ok(failure, 'bootstrap certificate must be rejected by the authenticated host')
        assert.equal(failure.killed, false, 'negative proof is not a runner timeout')
        assert.equal(relay.stats.requests, 0)
      }
      assert.equal(relay.stats.plaintextObserved, false)
      cases.push({ name, passed: true, ...relay.stats })
    } finally { await relay.cleanup() }
  }
  console.log(JSON.stringify({ scope: 'G0 software CSR interoperability only; not pairing, grant, local confirmation or iPhone', cases }, null, 2))
} finally { await identity.cleanup() }
