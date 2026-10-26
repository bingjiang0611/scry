import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { decodedBase64ByteLength, isSupportedImageMimeType, type AgentInputAttachment } from '../../shared/runtime'
import type { RunLifecycle } from './session-ledger'

export const DESKTOP_ATTACHMENT_CHUNK_BYTES = 256 * 1024
export const DESKTOP_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const DESKTOP_ATTACHMENT_MAX_COUNT = 16
export const DESKTOP_ATTACHMENT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000
const MAX_STAGED_BYTES = 128 * 1024 * 1024
const MAX_STAGED_FILES = 64
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface DesktopAttachmentCapability {
  transport: 'chunked'
  maxBytes: number
  maxTotalBytes: number
  maxCount: number
  chunkBytes: number
}
export interface DesktopAttachmentMetadata {
  attachmentId: string
  intentId: string
  name: string
  mimeType: AgentInputAttachment['mimeType']
  size: number
  sha256: string
  index: number
  totalCount: number
}
export interface DesktopAttachmentReference extends DesktopAttachmentMetadata { peer: string }
function fail(code: string): never { throw new Error(code) }
function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f/\\]/.test(value) && value !== '.' && value !== '..'
}
function validPeer(value: unknown): value is string { return typeof value === 'string' && HASH.test(value) }
function validId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function imageBytesMatch(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  if (mimeType === 'image/gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  return mimeType === 'image/webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}
export function normalizeDesktopAttachment(value: unknown): AgentInputAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('attachment_invalid')
  const item = value as Partial<AgentInputAttachment>
  if (item.kind !== 'image' || !validName(item.name) || !isSupportedImageMimeType(String(item.mimeType)) || typeof item.dataBase64 !== 'string' || item.path !== undefined) fail(item.path !== undefined ? 'attachment_path_forbidden' : 'attachment_invalid')
  const size = decodedBase64ByteLength(item.dataBase64)
  if (size == null || size <= 0 || size > DESKTOP_ATTACHMENT_MAX_BYTES || (item.size !== undefined && item.size !== size)) fail('attachment_invalid')
  if (!imageBytesMatch(Buffer.from(item.dataBase64, 'base64'), item.mimeType!)) fail('attachment_mime_mismatch')
  return { kind: 'image', name: item.name, mimeType: item.mimeType!, dataBase64: item.dataBase64, size,
    ...(Number.isSafeInteger(item.width) && item.width! > 0 ? { width: item.width } : {}),
    ...(Number.isSafeInteger(item.height) && item.height! > 0 ? { height: item.height } : {}) }
}
export function attachmentCapability(): DesktopAttachmentCapability {
  return { transport: 'chunked', maxBytes: DESKTOP_ATTACHMENT_MAX_BYTES, maxTotalBytes: DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES, maxCount: DESKTOP_ATTACHMENT_MAX_COUNT, chunkBytes: DESKTOP_ATTACHMENT_CHUNK_BYTES }
}

export class DesktopAttachmentStore {
  #serial: Promise<unknown> = Promise.resolve()
  readonly root: string
  private readonly intentState: (peer: string, id: string) => RunLifecycle | undefined
  constructor(root: string, intentState: (peer: string, id: string) => RunLifecycle | undefined = () => undefined) {
    this.root = root
    this.intentState = intentState
  }
  #locked<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(operation)
    this.#serial = next.catch(() => {})
    return next
  }
  async #entries(): Promise<Array<{ peer: string; metadata: DesktopAttachmentMetadata; mtime: number; committed: boolean }>> {
    let peers: import('node:fs').Dirent[]
    try { peers = await fs.readdir(this.root, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const entries: Array<{ peer: string; metadata: DesktopAttachmentMetadata; mtime: number; committed: boolean }> = []
    for (const peer of peers) {
      if (!peer.isDirectory() || !validPeer(peer.name)) continue
      for (const file of await fs.readdir(join(this.root, peer.name), { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.meta.json')) continue
        const path = join(this.root, peer.name, file.name)
        const metadata = JSON.parse(await fs.readFile(path, 'utf8')) as DesktopAttachmentMetadata
        this.#validate(peer.name, metadata)
        entries.push({ peer: peer.name, metadata, mtime: (await fs.stat(path)).mtimeMs, committed: file.name.endsWith('.committed.meta.json') })
      }
    }
    return entries
  }
  cleanup(now = Date.now()): Promise<void> { return this.#locked(() => this.#cleanup(now)) }
  async #cleanup(now: number): Promise<void> {
    for (const entry of await this.#entries()) {
      const state = this.intentState(entry.peer, entry.metadata.intentId)
      if (state === 'recorded' || state === 'dispatched') continue
      if (state !== undefined || now - entry.mtime >= DESKTOP_ATTACHMENT_ORPHAN_TTL_MS) await this.#remove(entry.peer, entry.metadata.attachmentId)
    }
  }
  begin(peer: string, metadata: DesktopAttachmentMetadata): Promise<void> {
    return this.#locked(async () => {
      this.#validate(peer, metadata)
      await this.#cleanup(Date.now())
      const entries = await this.#entries()
      const existing = entries.find(entry => entry.peer === peer && entry.metadata.attachmentId === metadata.attachmentId)
      if (existing) { this.#same(existing.metadata, metadata); return }
      const batch = entries.filter(entry => entry.peer === peer && entry.metadata.intentId === metadata.intentId)
      if (batch.some(entry => entry.metadata.index === metadata.index || entry.metadata.totalCount !== metadata.totalCount) || batch.length >= metadata.totalCount || batch.reduce((sum, entry) => sum + entry.metadata.size, metadata.size) > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) fail('attachment_upload_conflict')
      // Reservation counts declared bytes, not just bytes received. A peer cannot
      // reserve unbounded sparse uploads or leak committed-but-unsubmitted blobs.
      if (entries.length >= MAX_STAGED_FILES || entries.reduce((sum, entry) => sum + entry.metadata.size, metadata.size) > MAX_STAGED_BYTES) fail('attachment_staging_full')
      await fs.mkdir(join(this.root, peer), { recursive: true, mode: 0o700 })
      const handle = await fs.open(this.#path(peer, metadata.attachmentId, 'part'), 'wx', 0o600)
      await handle.close()
      try { await fs.writeFile(this.#path(peer, metadata.attachmentId, 'meta.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 }) }
      catch (error) { await fs.rm(this.#path(peer, metadata.attachmentId, 'part'), { force: true }); throw error }
    })
  }
  chunk(peer: string, input: { attachmentId: string; offset: number; dataBase64: string }): Promise<{ offset: number }> {
    return this.#locked(async () => {
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || typeof input.dataBase64 !== 'string' || input.dataBase64.length > Math.ceil(DESKTOP_ATTACHMENT_CHUNK_BYTES / 3) * 4) fail('attachment_invalid')
      const bytes = Buffer.from(input.dataBase64, 'base64')
      if (!bytes.length || bytes.length > DESKTOP_ATTACHMENT_CHUNK_BYTES || bytes.toString('base64') !== input.dataBase64) fail('attachment_invalid')
      const metadata = await this.#metadata(peer, input.attachmentId, false)
      if (input.offset + bytes.length > metadata.size) fail('attachment_invalid')
      const handle = await fs.open(this.#path(peer, input.attachmentId, 'part'), 'r+')
      try {
        if ((await handle.stat()).size !== input.offset) fail('attachment_offset_mismatch')
        let written = 0
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, input.offset + written)
          if (!result.bytesWritten) fail('attachment_write_failed')
          written += result.bytesWritten
        }
      } finally { await handle.close() }
      return { offset: input.offset + bytes.length }
    })
  }
  commit(peer: string, attachmentId: string): Promise<DesktopAttachmentReference> {
    return this.#locked(async () => {
      const metadata = await this.#metadata(peer, attachmentId, false)
      const bytes = await fs.readFile(this.#path(peer, attachmentId, 'part'))
      this.#checkBytes(metadata, bytes)
      await fs.rename(this.#path(peer, attachmentId, 'part'), this.#path(peer, attachmentId, 'blob'))
      await fs.rename(this.#path(peer, attachmentId, 'meta.json'), this.#path(peer, attachmentId, 'committed.meta.json'))
      return { ...metadata, peer }
    })
  }
  validateReferences(peer: string, intentId: string, references: DesktopAttachmentReference[]): Promise<void> {
    return this.#locked(async () => {
      if (!references.length || references.length > DESKTOP_ATTACHMENT_MAX_COUNT || new Set(references.map(ref => ref.index)).size !== references.length || references.reduce((sum, ref) => sum + ref.size, 0) > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) fail('attachment_reference_mismatch')
      for (const reference of references) {
        if (reference.peer !== peer || reference.intentId !== intentId || reference.totalCount !== references.length || reference.index >= references.length) fail('attachment_reference_mismatch')
        this.#validate(peer, reference)
        this.#same(await this.#metadata(peer, reference.attachmentId, true), reference)
      }
    })
  }
  read(reference: DesktopAttachmentReference): Promise<AgentInputAttachment> {
    return this.#locked(async () => {
      this.#validate(reference.peer, reference)
      const metadata = await this.#metadata(reference.peer, reference.attachmentId, true)
      this.#same(metadata, reference)
      const bytes = await fs.readFile(this.#path(reference.peer, reference.attachmentId, 'blob'))
      this.#checkBytes(metadata, bytes)
      return { kind: 'image', name: metadata.name, mimeType: metadata.mimeType, dataBase64: bytes.toString('base64'), size: bytes.length }
    })
  }
  remove(peer: string, id: string): Promise<void> { return this.#locked(() => this.#remove(peer, id)) }
  #validate(peer: string, value: DesktopAttachmentMetadata): void {
    if (!validPeer(peer) || !validId(value.attachmentId) || !validId(value.intentId) || !validName(value.name) || !isSupportedImageMimeType(value.mimeType) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > DESKTOP_ATTACHMENT_MAX_BYTES || !HASH.test(value.sha256) || !Number.isSafeInteger(value.index) || value.index < 0 || !Number.isSafeInteger(value.totalCount) || value.totalCount < 1 || value.totalCount > DESKTOP_ATTACHMENT_MAX_COUNT || value.index >= value.totalCount) fail('attachment_invalid')
  }
  #same(metadata: DesktopAttachmentMetadata, reference: DesktopAttachmentMetadata): void {
    for (const key of Object.keys(metadata) as Array<keyof DesktopAttachmentMetadata>) if (metadata[key] !== reference[key]) fail('attachment_reference_mismatch')
  }
  #checkBytes(metadata: DesktopAttachmentMetadata, bytes: Buffer): void {
    if (bytes.length !== metadata.size || digest(bytes) !== metadata.sha256 || !imageBytesMatch(bytes, metadata.mimeType)) fail('attachment_hash_mismatch')
  }
  #path(peer: string, id: string, suffix: string): string {
    if (!validPeer(peer) || !validId(id)) fail('attachment_invalid')
    return join(this.root, peer, `${id}.${suffix}`)
  }
  async #metadata(peer: string, id: string, committed: boolean): Promise<DesktopAttachmentMetadata> {
    let raw: string
    try { raw = await fs.readFile(this.#path(peer, id, committed ? 'committed.meta.json' : 'meta.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(committed ? 'attachment_reference_missing' : 'attachment_upload_missing'); throw error }
    const metadata = JSON.parse(raw) as DesktopAttachmentMetadata
    this.#validate(peer, metadata)
    return metadata
  }
  async #remove(peer: string, id: string): Promise<void> {
    await Promise.all(['meta.json', 'committed.meta.json', 'part', 'blob'].map(suffix => fs.rm(this.#path(peer, id, suffix), { force: true })))
  }
}
export function newAttachmentId(): string { return randomUUID() }
export function attachmentSha256(attachment: AgentInputAttachment): string { return digest(Buffer.from(attachment.dataBase64, 'base64')) }
