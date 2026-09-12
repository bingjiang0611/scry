import 'reflect-metadata'
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { createHash, createPrivateKey, randomUUID, webcrypto, X509Certificate as NodeCertificate } from 'node:crypto'
import { join } from 'node:path'
import {
  X509Certificate,
  X509CertificateGenerator,
  BasicConstraintsExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  ExtendedKeyUsageExtension,
  ExtendedKeyUsage,
  cryptoProvider
} from '@peculiar/x509'
import { verifyCSR, certificateIssuer, type CertificateIssuer } from './enrollment'
import type { VerifiedPairingCSR } from './pairing'

// The host's stable pairing identity: a per-install self-signed EC P-256 inner
// CA plus a stable hostId. The device pins the CA (anchorSHA256); the pairing
// authority issues device certificates under it. Generated once and persisted
// privately so it survives restarts (PairingAuthority fails closed if the host
// identity changes between launches).
//
// The CA private key is stored 0600 under Scry's userData. This is deliberately
// simple and honest: it is NOT the macOS Keychain and offers no protection
// against another process running as the same user. Moving the CA key into the
// Keychain (as the G0 device identity already is) is a tracked follow-up; until
// then callers must treat the state directory as sensitive.

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
const NODE_CRYPTO = webcrypto as unknown as PeculiarCrypto
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface HostServerCredentials {
  // A fresh CA-signed serverAuth leaf for the inner-mTLS host. The device trusts
  // the pinned CA (anchorSHA256), not this leaf, so regenerating it each launch
  // is safe.
  certificatePEM: string
  privateKeyPEM: string
}

export interface HostIdentity {
  hostId: string
  anchorSHA256: string
  caCertificatePEM: string
  verifyCSR(csrPEM: string): Promise<VerifiedPairingCSR>
  issue: CertificateIssuer
  // Mint a server credential the inner-mTLS host presents to devices.
  issueHostServer(): Promise<HostServerCredentials>
}

interface PersistedIdentity {
  version: 1
  hostId: string
  caCertificatePEM: string
  caPrivateKeyPEM: string
}

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

function digestHex(bytes: ArrayBuffer | Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes as Uint8Array)).digest('hex')
}

function writePrivateAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp-${randomUUID()}`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  const dir = openSync(join(path, '..'), 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
}

async function generateCA(): Promise<{ caCertificatePEM: string; caPrivateKeyPEM: string }> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomUUID().replace(/-/g, ''),
    name: 'CN=scry-host-inner-ca',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3650 * 86_400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.digitalSignature, true)
    ]
  }, NODE_CRYPTO)
  return { caCertificatePEM: cert.toString('pem'), caPrivateKeyPEM: toPem(pkcs8, 'PRIVATE KEY') }
}

async function issueHostServer(persisted: PersistedIdentity): Promise<HostServerCredentials> {
  const caInfo = new X509Certificate(persisted.caCertificatePEM)
  const caNode = new NodeCertificate(persisted.caCertificatePEM)
  const caKey = createPrivateKey(persisted.caPrivateKeyPEM)
  const signingKey = await webcrypto.subtle.importKey(
    'pkcs8', caKey.export({ type: 'pkcs8', format: 'der' }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  )
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const notAfter = Math.min(Date.now() + 30 * 86_400_000, Date.parse(caNode.validTo))
  const cert = await X509CertificateGenerator.create({
    publicKey: keys.publicKey,
    signingKey,
    subject: 'CN=scry-host',
    issuer: caInfo.subject,
    serialNumber: randomUUID().replace(/-/g, ''),
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(notAfter),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth])
    ]
  }, NODE_CRYPTO)
  return { certificatePEM: cert.toString('pem'), privateKeyPEM: toPem(pkcs8, 'PRIVATE KEY') }
}

async function assemble(persisted: PersistedIdentity): Promise<HostIdentity> {
  const anchorSHA256 = digestHex(new NodeCertificate(persisted.caCertificatePEM).raw)
  const issue = await certificateIssuer({ certificatePEM: persisted.caCertificatePEM, privateKeyPEM: persisted.caPrivateKeyPEM })
  return {
    hostId: persisted.hostId, anchorSHA256, caCertificatePEM: persisted.caCertificatePEM, verifyCSR, issue,
    issueHostServer: () => issueHostServer(persisted)
  }
}

// Load the persisted host identity, generating and durably storing it on first
// run. The directory is created private (0700); the identity file is 0600.
export async function ensureHostIdentity(stateDirectory: string): Promise<HostIdentity> {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  chmodSync(stateDirectory, 0o700)
  const path = join(stateDirectory, 'host-identity.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedIdentity
    if (parsed?.version !== 1 || !UUID.test(parsed.hostId) ||
        typeof parsed.caCertificatePEM !== 'string' || typeof parsed.caPrivateKeyPEM !== 'string') {
      throw new Error('host_identity_corrupt')
    }
    return await assemble(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const ca = await generateCA()
  const identity: PersistedIdentity = { version: 1, hostId: randomUUID(), ...ca }
  writePrivateAtomic(path, JSON.stringify(identity))
  return await assemble(identity)
}
