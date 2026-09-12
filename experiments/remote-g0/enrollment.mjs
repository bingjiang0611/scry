import 'reflect-metadata'
import { createHash, createPrivateKey, X509Certificate as NodeCertificate, webcrypto, randomBytes } from 'node:crypto'
import { Pkcs10CertificateRequest, X509Certificate, X509CertificateGenerator,
  BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags, ExtendedKeyUsageExtension, ExtendedKeyUsage } from '@peculiar/x509'

const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex')
const parseOptions = { berOptions: { maxDepth: 20, maxNodes: 256, maxContentLength: 16_384 } }
const hashName = hash => typeof hash === 'string' ? hash : hash?.name
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// This is cryptographic verification, NOT enrollment or local approval. The
// pairing authority must also bind a secret, live channel proof and user intent.
export async function verifyCSR(input) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new Error('invalid_csr')
  const size = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength
  if (!size || size > 16_384) throw new Error('invalid_csr_size')
  const bytes = Buffer.from(input)
  let csr
  try { csr = new Pkcs10CertificateRequest(bytes, parseOptions) }
  catch { throw new Error('invalid_csr') }
  if (csr.publicKey.algorithm.name !== 'ECDSA' || csr.publicKey.algorithm.namedCurve !== 'P-256' ||
      csr.signatureAlgorithm.name !== 'ECDSA' || hashName(csr.signatureAlgorithm.hash) !== 'SHA-256') {
    throw new Error('unsupported_csr_algorithm')
  }
  let valid
  try { valid = await csr.verify(webcrypto) }
  catch { throw new Error('invalid_csr_signature') }
  if (!valid) throw new Error('invalid_csr_signature')
  return Object.freeze({ csrPEM: csr.toString('pem'), csrSHA256: digest(csr.rawData), publicKeySHA256: digest(csr.publicKey.rawData) })
}

// A local crypto adapter only; never expose this closure as a remote operation.
// Call AFTER explicit local confirmation and return its certificate to the
// device only AFTER the grant + pairing-consumption transaction is durable.
export async function certificateIssuer({ certificatePEM, privateKeyPEM, clock = Date.now }) {
  const ca = new NodeCertificate(certificatePEM)
  const caInfo = new X509Certificate(certificatePEM, parseOptions)
  const key = createPrivateKey(privateKeyPEM)
  if (!ca.ca || !ca.checkPrivateKey(key) || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('invalid_issuer_identity')
  }
  const signingKey = await webcrypto.subtle.importKey('pkcs8', key.export({ type: 'pkcs8', format: 'der' }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return async ({ csrPEM, expectedCSRHash, expectedPublicKeySHA256, deviceId }) => {
    if (typeof deviceId !== 'string' || !uuid.test(deviceId)) throw new Error('invalid_device_id')
    const verified = await verifyCSR(csrPEM)
    if (verified.csrSHA256 !== expectedCSRHash || verified.publicKeySHA256 !== expectedPublicKeySHA256) {
      throw new Error('approval_identity_changed')
    }
    const now = clock()
    const expiresAt = Math.min(now + 3_600_000, Date.parse(ca.validTo))
    if (!Number.isSafeInteger(now) || now < Date.parse(ca.validFrom) || expiresAt <= now) throw new Error('issuer_expired')
    const csr = new Pkcs10CertificateRequest(verified.csrPEM, parseOptions)
    const certificate = await X509CertificateGenerator.create({
      publicKey: csr.publicKey, signingKey, subject: `CN=scry-device-${deviceId}`, issuer: caInfo.subject,
      serialNumber: randomBytes(16).toString('hex'), notBefore: new Date(Math.max(now - 30_000, Date.parse(ca.validFrom))),
      notAfter: new Date(expiresAt), signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      // Requester-controlled subject, SAN, CA, extensions and validity are never copied.
      extensions: [new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth])]
    }, webcrypto)
    const pem = certificate.toString('pem')
    const issued = new NodeCertificate(pem)
    if (!issued.verify(ca.publicKey) || !issued.checkIssued(ca) || issued.ca) throw new Error('invalid_issued_certificate')
    return Object.freeze({ certificatePEM: pem, certificateSHA256: digest(issued.raw),
      publicKeySHA256: verified.publicKeySHA256, deviceId, expiresAt: Date.parse(issued.validTo) })
  }
}
