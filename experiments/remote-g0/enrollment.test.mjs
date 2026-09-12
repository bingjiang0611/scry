import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto, randomUUID, X509Certificate as NodeCertificate } from 'node:crypto'
import { verifyCSR, certificateIssuer } from './enrollment.mjs'
import { Pkcs10CertificateRequestGenerator, BasicConstraintsExtension, ExtendedKeyUsageExtension, ExtendedKeyUsage } from '@peculiar/x509'
import { certificates } from './fixture.mjs'

let identity, issuer
before(async () => {
  identity = await certificates()
  issuer = await certificateIssuer({ certificatePEM: await identity.read('inner-ca.pem'), privateKeyPEM: await identity.read('inner-ca.key') })
})
after(async () => { await identity?.cleanup() })
async function request({ curve = 'P-256', hash = 'SHA-256', extensions = [] } = {}) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify'])
  return Pkcs10CertificateRequestGenerator.create({ keys, name: 'CN=untrusted requester', extensions,
    signingAlgorithm: { name: 'ECDSA', hash } }, webcrypto)
}
function approved(snapshot, deviceId = randomUUID()) {
  // Synthetic test input, not a production local-confirmation receipt.
  return { csrPEM: snapshot.csrPEM, expectedCSRHash: snapshot.csrSHA256, expectedPublicKeySHA256: snapshot.publicKeySHA256, deviceId }
}

test('CSR signature verified; tampering and malformed/oversized inputs rejected', async () => {
  const csr = await request()
  const snapshot = await verifyCSR(csr.toString('pem'))
  assert.match(snapshot.publicKeySHA256, /^[a-f0-9]{64}$/)
  assert.equal((await verifyCSR(Buffer.from(csr.rawData))).csrSHA256, snapshot.csrSHA256)
  const altered = Buffer.from(csr.rawData); altered[altered.length - 1] ^= 1
  await assert.rejects(verifyCSR(altered), /invalid_csr_signature/)
  await assert.rejects(verifyCSR('not a CSR'), /invalid_csr/)
  await assert.rejects(verifyCSR(Buffer.alloc(16_385)), /invalid_csr_size/)
  await assert.rejects(verifyCSR({}), /invalid_csr/)
})

test('only P-256 / SHA-256 enrollment is accepted', async () => {
  await assert.rejects(verifyCSR((await request({ curve: 'P-384' })).toString('pem')), /unsupported_csr_algorithm/)
  await assert.rejects(verifyCSR((await request({ hash: 'SHA-384' })).toString('pem')), /unsupported_csr_algorithm/)
})

test('issued certificate ignores requester CA, serverAuth, and subject', async () => {
  const csr = await request({ extensions: [new BasicConstraintsExtension(true), new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth])] })
  const snapshot = await verifyCSR(csr.toString('pem'))
  const input = approved(snapshot)
  const result = await issuer(input)
  const issued = new NodeCertificate(result.certificatePEM)
  assert.equal(issued.ca, false)
  assert.equal(issued.subject, `CN=scry-device-${input.deviceId}`)
  assert.deepEqual(issued.keyUsage, [ExtendedKeyUsage.clientAuth])
  assert.equal(issued.verify(new NodeCertificate(await identity.read('inner-ca.pem')).publicKey), true)
  assert.equal(result.publicKeySHA256, snapshot.publicKeySHA256)
})

test('changed approval binding or invalid host-assigned ID cannot issue', async () => {
  const snapshot = await verifyCSR((await request()).toString('pem'))
  await assert.rejects(issuer({ ...approved(snapshot), expectedCSRHash: '0'.repeat(64) }), /approval_identity_changed/)
  await assert.rejects(issuer({ ...approved(snapshot), expectedPublicKeySHA256: '0'.repeat(64) }), /approval_identity_changed/)
  await assert.rejects(issuer(approved(snapshot, 'device-from-phone')), /invalid_device_id/)
})

test('CA key mismatch and expired issuer fail closed', async () => {
  await assert.rejects(certificateIssuer({ certificatePEM: await identity.read('inner-ca.pem'), privateKeyPEM: await identity.read('wrong-ca.key') }), /invalid_issuer_identity/)
  const expired = await certificateIssuer({ certificatePEM: await identity.read('inner-ca.pem'), privateKeyPEM: await identity.read('inner-ca.key'), clock: () => Date.now() + 172_800_000 })
  await assert.rejects(expired(approved(await verifyCSR((await request()).toString('pem')))), /issuer_expired/)
})
