import 'reflect-metadata'
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, X509Certificate as NodeCertificate } from 'node:crypto'
import { webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from './host-identity'

type PeculiarCrypto = Parameters<typeof cryptoProvider.set>[0]
cryptoProvider.set(webcrypto as unknown as PeculiarCrypto)

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'scry-id-')); dirs.push(d); return d }

async function deviceCSR(): Promise<string> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const csr = await Pkcs10CertificateRequestGenerator.create({ name: 'CN=device', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } })
  return csr.toString('pem')
}

describe('ensureHostIdentity', () => {
  it('generates a stable, private identity that persists across restarts', async () => {
    const dir = tmp()
    const first = await ensureHostIdentity(dir)
    expect(first.hostId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.anchorSHA256).toMatch(/^[0-9a-f]{64}$/)
    // The persisted key material is 0600.
    const mode = statSync(join(dir, 'host-identity.json')).mode & 0o777
    expect(mode).toBe(0o600)

    const second = await ensureHostIdentity(dir)
    expect(second.hostId).toBe(first.hostId)
    expect(second.anchorSHA256).toBe(first.anchorSHA256)
    expect(second.caCertificatePEM).toBe(first.caCertificatePEM)
  })

  it('issues a device certificate that chains to the persisted inner CA', async () => {
    const identity = await ensureHostIdentity(tmp())
    const verified = await identity.verifyCSR(await deviceCSR())
    const issued = await identity.issue({ ...verified, deviceId: randomUUID() })
    const cert = new NodeCertificate(issued.certificatePEM)
    const ca = new NodeCertificate(identity.caCertificatePEM)
    expect(cert.verify(ca.publicKey)).toBe(true)
    expect(cert.checkIssued(ca)).toBe(true)
    expect(cert.ca).toBe(false)
  })

  it('fails closed on a corrupt identity file rather than minting a new CA', async () => {
    const dir = tmp()
    await ensureHostIdentity(dir)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'host-identity.json'), '{"version":1,"hostId":"nope"}')
    await expect(ensureHostIdentity(dir)).rejects.toThrow('host_identity_corrupt')
    // The original CA on disk is untouched (not silently replaced).
    expect(readFileSync(join(dir, 'host-identity.json'), 'utf8')).toContain('"hostId":"nope"')
  })
})
