import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { UploadError } from './errors.js'
import { digest } from './storage.js'

export const CONTENT_PROTOCOL = 'recorder-content-v1'
export const MAX_DECODED_RECORD_BYTES = 16 * 1024 * 1024
const MAX_CONTENT_BLOBS = 512

interface ContentRef {
  storage: typeof CONTENT_PROTOCOL
  sha256: string
  bytes: number
  encoding: 'utf8' | 'json'
}
interface ContentBlob {
  sha256: string
  bytes: number
  dataBase64: string
}

function invalid(message: string): never {
  throw new UploadError('content_integrity', message, true)
}

export function contentReferences(recordJson: string): Map<string, ContentRef> {
  const refs = new Map<string, ContentRef>()
  const canonical: unknown = JSON.parse(recordJson)
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical) || 'scryEncoding' in canonical)
    invalid('recordJson must be an original canonical object, not a transport envelope')
  const pending: unknown[] = [canonical]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item)
      continue
    }
    const object = value as Record<string, unknown>
    if (object.storage === CONTENT_PROTOCOL) {
      if (typeof object.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(object.sha256) ||
          !Number.isSafeInteger(object.bytes) || Number(object.bytes) < 0 || Number(object.bytes) > MAX_DECODED_RECORD_BYTES ||
          (object.encoding !== 'utf8' && object.encoding !== 'json')) invalid('invalid content reference')
      const ref = object as unknown as ContentRef
      const previous = refs.get(ref.sha256)
      if (previous && previous.bytes !== ref.bytes) invalid('conflicting content reference sizes')
      refs.set(ref.sha256, { ...ref, encoding: previous?.encoding === 'json' ? 'json' : ref.encoding })
      if (refs.size > MAX_CONTENT_BLOBS) invalid('content reference count exceeds 512')
    }
    for (const item of Object.values(object)) pending.push(item)
  }
  return refs
}

export function validateContent(recordJson: string, contentJson: string): void {
  if (Buffer.byteLength(contentJson) > MAX_DECODED_RECORD_BYTES) invalid('content exceeds transport limit')
  const refs = contentReferences(recordJson)
  const blobs: unknown = JSON.parse(contentJson)
  if (!Array.isArray(blobs) || blobs.length !== refs.size) invalid('content does not cover canonical references')
  const seen = new Set<string>()
  for (const value of blobs) {
    if (!value || typeof value !== 'object') invalid('invalid content blob')
    const blob = value as ContentBlob
    const ref = refs.get(blob.sha256)
    if (!ref || seen.has(blob.sha256) || blob.bytes !== ref.bytes || typeof blob.dataBase64 !== 'string')
      invalid('content identity mismatch')
    const raw = Buffer.from(blob.dataBase64, 'base64')
    if (raw.toString('base64') !== blob.dataBase64 || raw.length !== ref.bytes || digest(raw) !== ref.sha256)
      invalid('content bytes do not match canonical reference')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    if (ref.encoding === 'json') JSON.parse(text)
    seen.add(blob.sha256)
  }
}

export async function captureContent(data: string, recordJson: string): Promise<string | undefined> {
  const refs = contentReferences(recordJson)
  if (!refs.size) return undefined
  const root = await realpath(data)
  const blobs: ContentBlob[] = []
  let totalBytes = 0
  for (const ref of [...refs.values()].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
    totalBytes += ref.bytes
    if (totalBytes > MAX_DECODED_RECORD_BYTES) invalid('content exceeds transport limit')
    const path = await realpath(join(data, 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`))
    const inside = relative(root, path)
    if (isAbsolute(inside) || inside === '..' || inside.startsWith('../')) invalid('content path escapes data directory')
    const info = await stat(path)
    if (!info.isFile() || info.size !== ref.bytes) invalid('source content size or type does not match reference')
    const raw = await readFile(path)
    if (raw.length !== ref.bytes || digest(raw) !== ref.sha256) invalid('source content integrity check failed')
    blobs.push({ sha256: ref.sha256, bytes: raw.length, dataBase64: raw.toString('base64') })
  }
  const contentJson = JSON.stringify(blobs)
  validateContent(recordJson, contentJson)
  contentRecord(recordJson, contentJson)
  return contentJson
}

export function contentRecord(recordJson: string, contentJson: string): string {
  const record = JSON.stringify({ scryEncoding: CONTENT_PROTOCOL, recordJson, contentJson })
  if (Buffer.byteLength(record) > MAX_DECODED_RECORD_BYTES) invalid('record and content exceed 16 MiB decoded limit')
  return record
}

export function custodyContentPath(base: string, sequence: number, recordId: string): string {
  return join(base, 'outbox', 'committed', 'content', `${String(sequence).padStart(20, '0')}-${recordId}.json`)
}
