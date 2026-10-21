import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DESKTOP_ATTACHMENT_CHUNK_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_ORPHAN_TTL_MS, DesktopAttachmentStore, normalizeDesktopAttachment } from './desktop-attachments'
import { HostController, type RemoteIntentRouting } from './host-controller'
import type { PairingDependencies, PairingPersistence, PairingState, IssuedPairingCertificate } from './pairing'
import type { LedgerEvent, LedgerStore } from './session-ledger'

const peer = 'a'.repeat(64)
const anchor = 'c'.repeat(64)
class PairingStore implements PairingPersistence {
  value: PairingState | undefined
  assertAvailable(): void {}
  load(): unknown { return structuredClone(this.value) }
  commit(state: PairingState): void { this.value = structuredClone(state) }
}
class LedgerStoreMemory implements LedgerStore {
  log: LedgerEvent[] = []
  assertAvailable(): void {}
  loadAll(): LedgerEvent[] { return this.log.map((event) => ({ ...event })) }
  append(event: LedgerEvent): void { this.log.push({ ...event }) }
}
function pairing(): PairingDependencies {
  const issue = async ({ deviceId }: { deviceId: string }): Promise<IssuedPairingCertificate> => ({ deviceId, certificatePEM: 'synthetic', certificateSHA256: peer, publicKeySHA256: 'b'.repeat(64), expiresAt: Date.now() + 3_600_000 })
  return { store: new PairingStore(), hostId: randomUUID(), anchorSHA256: anchor, verifyCSR: async (csrPEM) => ({ csrPEM, csrSHA256: 'e'.repeat(64), publicKeySHA256: 'b'.repeat(64) }), issue }
}

function pngBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  return bytes
}

describe('desktop attachment transport storage', () => {
  it('reassembles and verifies a real image larger than the legacy inline limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-desktop-attachments-'))
    try {
      const store = new DesktopAttachmentStore(root)
      const bytes = pngBytes(600 * 1024)
      const metadata = { attachmentId: randomUUID(), intentId: randomUUID(), name: 'screen.png', mimeType: 'image/png' as const, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), index: 0, totalCount: 1 }
      await store.begin(peer, metadata)
      for (let offset = 0; offset < bytes.length; offset += DESKTOP_ATTACHMENT_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + DESKTOP_ATTACHMENT_CHUNK_BYTES))
        await store.chunk(peer, { attachmentId: metadata.attachmentId, offset, dataBase64: chunk.toString('base64') })
      }
      const reference = await store.commit(peer, metadata.attachmentId)
      const attachment = await store.read(reference)
      expect(Buffer.from(attachment.dataBase64, 'base64')).toEqual(bytes)
      await store.remove(peer, metadata.attachmentId)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('delivers the committed bytes through the canonical host run routing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-desktop-attachments-'))
    try {
      const store = new DesktopAttachmentStore(root)
      const bytes = pngBytes(600 * 1024)
      const metadata = { attachmentId: randomUUID(), intentId: randomUUID(), name: 'screen.png', mimeType: 'image/png' as const, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), index: 0, totalCount: 1 }
      await store.begin(peer, metadata)
      for (let offset = 0; offset < bytes.length; offset += DESKTOP_ATTACHMENT_CHUNK_BYTES) await store.chunk(peer, { attachmentId: metadata.attachmentId, offset, dataBase64: bytes.subarray(offset, Math.min(bytes.length, offset + DESKTOP_ATTACHMENT_CHUNK_BYTES)).toString('base64') })
      const reference = await store.commit(peer, metadata.attachmentId)
      await store.read(reference)
      let seen: RemoteIntentRouting | undefined
      const controller = new HostController({ pairing: pairing(), ledgerStore: new LedgerStoreMemory(), workspace: { authorize: (cwd) => cwd }, attachmentStore: store, runProvider: async ({ routing }) => { seen = routing } })
      const pair = await controller.authority.begin()
      await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'csr', deviceLabel: 'desktop' }, 'b'.repeat(64))
      await controller.authority.confirmLocal(pair.pairingId, 'b'.repeat(64))
      const request = { intentId: metadata.intentId, detail: JSON.stringify({ cwd: '/project', providerId: 'claude', prompt: 'inspect', attachments: [{ kind: 'image', dataBase64: '', ...metadata }] }) }
      expect(() => controller.submitIntent(peer, request)).toThrow('attachment_requires_validated_submit')
      await expect(controller.submitReceivedIntent(peer, { ...request, intentId: randomUUID() })).rejects.toThrow('attachment_reference_mismatch')
      expect(seen).toBeUndefined()
      const accepted = await controller.submitReceivedIntent(peer, request)
      await controller.idle()
      const state = controller.runState(peer, { runId: accepted.runId })
      if (state !== 'settled') throw new Error(JSON.stringify(controller.poll(peer, { cursor: 0 })))
      expect(Buffer.from(seen!.attachments![0]!.dataBase64, 'base64')).toEqual(bytes)
      await expect(store.read(reference)).rejects.toThrow('attachment_reference_missing')
      await expect(controller.submitReceivedIntent(peer, request)).resolves.toEqual({ runId: accepted.runId, status: 'duplicate' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('bounds reservations across images and batches, including incomplete uploads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-attachment-quota-'))
    try {
      const store = new DesktopAttachmentStore(root)
      const metadata = { attachmentId: randomUUID(), intentId: randomUUID(), name: 'large.png', mimeType: 'image/png' as const, size: DESKTOP_ATTACHMENT_MAX_BYTES, sha256: 'f'.repeat(64), index: 0, totalCount: 3 }
      await store.begin(peer, metadata)
      await expect(store.begin(peer, { ...metadata, attachmentId: randomUUID() })).rejects.toThrow('attachment_upload_conflict')
      await store.begin(peer, { ...metadata, attachmentId: randomUUID(), index: 1 })
      await expect(store.begin(peer, { ...metadata, attachmentId: randomUUID(), index: 2 })).rejects.toThrow('attachment_upload_conflict')
      for (let index = 0; index < 6; index++) await store.begin(peer, { ...metadata, attachmentId: randomUUID(), intentId: randomUUID(), totalCount: 1 })
      await expect(store.begin(peer, { ...metadata, attachmentId: randomUUID(), intentId: randomUUID(), totalCount: 1 })).rejects.toThrow('attachment_staging_full')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reclaims committed orphans but preserves recorded work across recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-attachment-recovery-'))
    let lifecycle: 'recorded' | 'failed' | undefined
    try {
      const store = new DesktopAttachmentStore(root, (owner) => owner === peer ? lifecycle : undefined)
      const bytes = pngBytes(32)
      const metadata = { attachmentId: randomUUID(), intentId: randomUUID(), name: 'screen.png', mimeType: 'image/png' as const, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), index: 0, totalCount: 1 }
      await store.begin(peer, metadata)
      await store.chunk(peer, { attachmentId: metadata.attachmentId, offset: 0, dataBase64: bytes.toString('base64') })
      const reference = await store.commit(peer, metadata.attachmentId)
      await expect(store.read({ ...reference, peer: 'b'.repeat(64) })).rejects.toThrow('attachment_reference_missing')
      await expect(store.validateReferences(peer, randomUUID(), [reference])).rejects.toThrow('attachment_reference_mismatch')
      lifecycle = 'recorded'
      await store.cleanup(Date.now() + DESKTOP_ATTACHMENT_ORPHAN_TTL_MS + 1000)
      expect(Buffer.from((await store.read(reference)).dataBase64, 'base64')).toEqual(bytes)
      lifecycle = 'failed'
      await store.cleanup()
      await expect(store.read(reference)).rejects.toThrow('attachment_reference_missing')
      lifecycle = undefined
      await store.begin(peer, metadata)
      await store.chunk(peer, { attachmentId: metadata.attachmentId, offset: 0, dataBase64: bytes.toString('base64') })
      await store.commit(peer, metadata.attachmentId)
      await store.cleanup(Date.now() + DESKTOP_ATTACHMENT_ORPHAN_TTL_MS + 1000)
      await expect(store.read(reference)).rejects.toThrow('attachment_reference_missing')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not advertise chunked attachments from an old host without the store', async () => {
    const controller = new HostController({ pairing: pairing(), ledgerStore: new LedgerStoreMemory(), workspace: { authorize: (cwd) => cwd }, readDesktop: async () => ({ kind: 'info', protocol: 1, hostId: 'old-host', execution: 'canonical' }), runProvider: async () => {} })
    const pair = await controller.authority.begin()
    await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'csr', deviceLabel: 'desktop' }, 'b'.repeat(64))
    await controller.authority.confirmLocal(pair.pairingId, 'b'.repeat(64))
    const info = await controller.readDesktop(peer, { kind: 'info' })
    expect(info).not.toHaveProperty('attachments')
  })

  it('rejects renderer paths instead of treating them as host file paths', () => {
    expect(() => normalizeDesktopAttachment({ kind: 'image', name: '../secret.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' })).toThrow('attachment_invalid')
    expect(() => normalizeDesktopAttachment({ kind: 'image', name: 'screen.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=', path: '/private/secret.png' })).toThrow('attachment_path_forbidden')
  })
})
