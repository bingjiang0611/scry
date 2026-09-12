import 'reflect-metadata'
import { describe, it, expect, beforeAll } from 'vitest'
import { webcrypto, X509Certificate as NodeCertificate, randomUUID } from 'node:crypto'
import {
  X509CertificateGenerator,
  Pkcs10CertificateRequestGenerator,
  BasicConstraintsExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  cryptoProvider
} from '@peculiar/x509'
import { verifyCSR, certificateIssuer } from './enrollment'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

async function keyPairPem() {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  return { keys, privateKeyPEM: toPem(pkcs8, 'PRIVATE KEY') }
}

async function makeCA() {
  const { keys, privateKeyPEM } = await keyPairPem()
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: 'CN=scry-inner-ca', notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000), signingAlgorithm: SIGN, keys,
    extensions: [new BasicConstraintsExtension(true, undefined, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.digitalSignature, true)]
  })
  return { certificatePEM: cert.toString('pem'), privateKeyPEM }
}

async function makeCSR() {
  const { keys } = await keyPairPem()
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: SIGN })
  return csr.toString('pem')
}

describe('enrollment (host X.509 adapters)', () => {
  let ca: { certificatePEM: string; privateKeyPEM: string }
  beforeAll(async () => { ca = await makeCA() })

  it('verifies a well-formed P-256 CSR and returns stable fingerprints', async () => {
    const csrPEM = await makeCSR()
    const a = await verifyCSR(csrPEM)
    const b = await verifyCSR(csrPEM)
    expect(a.csrSHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(a.publicKeySHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toEqual(b) // deterministic
  })

  it('rejects oversized or malformed CSRs', async () => {
    await expect(verifyCSR('x'.repeat(20_000))).rejects.toThrow('invalid_csr_size')
    await expect(verifyCSR('-----BEGIN CERTIFICATE REQUEST-----\nnope\n-----END CERTIFICATE REQUEST-----')).rejects.toThrow('invalid_csr')
    await expect(verifyCSR(123 as unknown as string)).rejects.toThrow('invalid_csr')
  })

  it('issues a short-lived clientAuth certificate that chains to the CA and is not a CA', async () => {
    const csrPEM = await makeCSR()
    const verified = await verifyCSR(csrPEM)
    const issue = await certificateIssuer(ca)
    const deviceId = randomUUID()
    const issued = await issue({ ...verified, deviceId })

    expect(issued.deviceId).toBe(deviceId)
    expect(issued.certificateSHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(issued.publicKeySHA256).toBe(verified.publicKeySHA256)
    const cert = new NodeCertificate(issued.certificatePEM)
    const caCert = new NodeCertificate(ca.certificatePEM)
    expect(cert.verify(caCert.publicKey)).toBe(true)
    expect(cert.checkIssued(caCert)).toBe(true)
    expect(cert.ca).toBe(false)
    expect(cert.subject).toContain(`scry-device-${deviceId}`)
    expect(issued.expiresAt).toBeGreaterThan(Date.now())
    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1000)
  })

  it('refuses to issue when the re-verified CSR identity does not match the approval', async () => {
    const verified = await verifyCSR(await makeCSR())
    const issue = await certificateIssuer(ca)
    await expect(issue({ ...verified, csrSHA256: 'f'.repeat(64), deviceId: randomUUID() })).rejects.toThrow('approval_identity_changed')
    await expect(issue({ ...verified, deviceId: 'not-a-uuid' })).rejects.toThrow('invalid_device_id')
  })

  it('rejects an issuer whose private key does not match its certificate', async () => {
    const otherKey = (await keyPairPem()).privateKeyPEM
    await expect(certificateIssuer({ certificatePEM: ca.certificatePEM, privateKeyPEM: otherKey })).rejects.toThrow('invalid_issuer_identity')
  })
})
