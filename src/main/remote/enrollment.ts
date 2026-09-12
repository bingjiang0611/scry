import 'reflect-metadata'
import { createHash, createPrivateKey, X509Certificate as NodeCertificate, webcrypto, randomBytes } from 'node:crypto'
import {
  Pkcs10CertificateRequest,
  X509Certificate,
  X509CertificateGenerator,
  BasicConstraintsExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  ExtendedKeyUsageExtension,
  ExtendedKeyUsage,
  cryptoProvider
} from '@peculiar/x509'
import type { VerifiedPairingCSR, IssuedPairingCertificate } from './pairing'

// @peculiar/x509 types its crypto arguments as the DOM `Crypto`, which is not in
// the Node lib. Derive the expected type from the API and bind Node's webcrypto
// as the default provider once, so call sites never name a DOM global.
type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
const NODE_CRYPTO = webcrypto as unknown as PeculiarCrypto
cryptoProvider.set(NODE_CRYPTO)

// Host-side X.509 adapters for the pairing authority, ported from the proven
// experiments/remote-g0 reference now that a production @peculiar/x509 dependency
// is approved. This module is pure cryptographic verification/issuance. It is
// NOT enrollment or local approval: PairingAuthority still binds the secret,
// the live inner-mTLS channel proof and explicit user intent, and only calls
// issue() AFTER local confirmation, returning the certificate to the device
// only AFTER the grant + secret-consumption transaction is durable.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// A device-supplied CSR is untrusted input; the byte cap is the parse bound.
const MAX_CSR_BYTES = 16_384

function digest(bytes: ArrayBuffer | Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes as Uint8Array)).digest('hex')
}

function hashName(hash: unknown): string | undefined {
  return typeof hash === 'string' ? hash : (hash as { name?: string } | undefined)?.name
}

// Verify a device CSR is a well-formed, self-consistent P-256/ECDSA-SHA256
// request. Returns the canonical PEM plus the CSR and public-key fingerprints
// the authority binds to the pending pairing.
export async function verifyCSR(input: string | Uint8Array): Promise<VerifiedPairingCSR> {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new Error('invalid_csr')
  const size = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength
  if (!size || size > MAX_CSR_BYTES) throw new Error('invalid_csr_size')
  const bytes = Buffer.from(input as Uint8Array)
  let csr: Pkcs10CertificateRequest
  try { csr = new Pkcs10CertificateRequest(bytes) }
  catch { throw new Error('invalid_csr') }
  const publicKeyAlg = csr.publicKey.algorithm as { name: string; namedCurve?: string }
  const signatureAlg = csr.signatureAlgorithm as { name: string; hash?: unknown }
  if (publicKeyAlg.name !== 'ECDSA' || publicKeyAlg.namedCurve !== 'P-256' ||
      signatureAlg.name !== 'ECDSA' || hashName(signatureAlg.hash) !== 'SHA-256') {
    throw new Error('unsupported_csr_algorithm')
  }
  let valid: boolean
  try { valid = await csr.verify(NODE_CRYPTO) }
  catch { throw new Error('invalid_csr_signature') }
  if (!valid) throw new Error('invalid_csr_signature')
  return Object.freeze({
    csrPEM: csr.toString('pem'),
    csrSHA256: digest(csr.rawData),
    publicKeySHA256: digest(csr.publicKey.rawData)
  })
}

export interface CertificateIssuerConfig {
  certificatePEM: string
  privateKeyPEM: string
  clock?: () => number
}

export type CertificateIssuer = (input: VerifiedPairingCSR & { deviceId: string }) => Promise<IssuedPairingCertificate>

// Build a client-certificate issuer bound to the inner CA. Validates the CA
// identity (EC/prime256v1, is a CA, holds the private key) up front, then
// returns a closure that issues a short-lived clientAuth certificate for a
// re-verified CSR. Requester-controlled subject, SAN, CA flag, extensions and
// validity are never copied from the CSR.
export async function certificateIssuer(config: CertificateIssuerConfig): Promise<CertificateIssuer> {
  const clock = config.clock ?? Date.now
  const ca = new NodeCertificate(config.certificatePEM)
  const caInfo = new X509Certificate(config.certificatePEM)
  const key = createPrivateKey(config.privateKeyPEM)
  if (!ca.ca || !ca.checkPrivateKey(key) || key.asymmetricKeyType !== 'ec' ||
      key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('invalid_issuer_identity')
  }
  const signingKey = await webcrypto.subtle.importKey(
    'pkcs8', key.export({ type: 'pkcs8', format: 'der' }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  )
  return async ({ csrPEM, csrSHA256, publicKeySHA256, deviceId }) => {
    if (typeof deviceId !== 'string' || !UUID.test(deviceId)) throw new Error('invalid_device_id')
    const verified = await verifyCSR(csrPEM)
    if (verified.csrSHA256 !== csrSHA256 || verified.publicKeySHA256 !== publicKeySHA256) {
      throw new Error('approval_identity_changed')
    }
    const now = clock()
    const expiresAt = Math.min(now + 3_600_000, Date.parse(ca.validTo))
    if (!Number.isSafeInteger(now) || now < Date.parse(ca.validFrom) || expiresAt <= now) throw new Error('issuer_expired')
    const csr = new Pkcs10CertificateRequest(verified.csrPEM)
    const certificate = await X509CertificateGenerator.create({
      publicKey: csr.publicKey,
      signingKey,
      subject: `CN=scry-device-${deviceId}`,
      issuer: caInfo.subject,
      serialNumber: randomBytes(16).toString('hex'),
      notBefore: new Date(Math.max(now - 30_000, Date.parse(ca.validFrom))),
      notAfter: new Date(expiresAt),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth])
      ]
    }, NODE_CRYPTO)
    const pem = certificate.toString('pem')
    const issued = new NodeCertificate(pem)
    if (!issued.verify(ca.publicKey) || !issued.checkIssued(ca) || issued.ca) throw new Error('invalid_issued_certificate')
    return Object.freeze({
      certificatePEM: pem,
      certificateSHA256: digest(issued.raw),
      publicKeySHA256: verified.publicKeySHA256,
      deviceId,
      expiresAt: Date.parse(issued.validTo)
    })
  }
}
