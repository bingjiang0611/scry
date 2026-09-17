import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isToolContentRef, type ToolContentRef } from '../../shared/tool-content.js'
import { writeFileAtomicExclusive } from './io.js'

function contentPath(dataRoot: string, sha256: string): string {
  return join(dataRoot, 'content', 'sha256', sha256.slice(0, 2), `${sha256}.bin`)
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

const verifiedContent = new Map<string, string>()
const VERIFIED_CONTENT_CACHE_LIMIT = 64

function contentIdentity(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

function rememberVerified(path: string, identity: string): void {
  verifiedContent.delete(path)
  verifiedContent.set(path, identity)
  while (verifiedContent.size > VERIFIED_CONTENT_CACHE_LIMIT) {
    const oldest = verifiedContent.keys().next().value
    if (typeof oldest !== 'string') break
    verifiedContent.delete(oldest)
  }
}

export async function writeRecorderContent(
  dataRoot: string,
  content: string,
  encoding: ToolContentRef['encoding']
): Promise<ToolContentRef> {
  const bytes = Buffer.from(content, 'utf8')
  const sha256 = digest(bytes)
  const path = contentPath(dataRoot, sha256)
  try {
    await writeFileAtomicExclusive(path, bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readFile(path)
    if (existing.length !== bytes.length || digest(existing) !== sha256) {
      throw new Error(`recorder content collision or corruption: ${sha256}`)
    }
  }
  return { storage: 'recorder-content-v1', sha256, bytes: bytes.length, encoding }
}

export async function readRecorderContent(dataRoot: string, ref: ToolContentRef): Promise<string> {
  if (!isToolContentRef(ref)) throw new Error('invalid recorder content reference')
  const content = await readFile(contentPath(dataRoot, ref.sha256))
  if (content.length !== ref.bytes || digest(content) !== ref.sha256) {
    throw new Error(`recorder content integrity check failed: ${ref.sha256}`)
  }
  return content.toString('utf8')
}

export interface RecorderContentPage {
  offset: number
  nextOffset: number
  totalBytes: number
  hasMore: boolean
  dataBase64: string
}

export async function readRecorderContentPage(
  dataRoot: string,
  ref: ToolContentRef,
  options: { offset?: number; limit?: number } = {}
): Promise<RecorderContentPage> {
  if (!isToolContentRef(ref)) throw new Error('invalid recorder content reference')
  const offset = options.offset ?? 0
  const limit = options.limit ?? 64 * 1024
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ref.bytes) throw new Error('invalid recorder content offset')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 * 1024) throw new Error('invalid recorder content limit')
  const length = Math.min(limit, ref.bytes - offset)
  const page = Buffer.allocUnsafe(length)
  const path = contentPath(dataRoot, ref.sha256)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size !== ref.bytes) {
      throw new Error(`recorder content integrity check failed: ${ref.sha256}`)
    }
    const identity = contentIdentity(before)
    const cached = verifiedContent.get(path) === identity
    if (cached) {
      let copied = 0
      while (copied < length) {
        const read = await handle.read(page, copied, length - copied, offset + copied)
        if (read.bytesRead === 0) break
        copied += read.bytesRead
      }
      if (copied !== length) throw new Error(`recorder content integrity check failed: ${ref.sha256}`)
    } else {
      const scratch = Buffer.allocUnsafe(64 * 1024)
      const hash = createHash('sha256')
      let position = 0
      let copied = 0
      while (position < ref.bytes) {
        const read = await handle.read(scratch, 0, Math.min(scratch.length, ref.bytes - position), position)
        if (read.bytesRead === 0) break
        const chunk = scratch.subarray(0, read.bytesRead)
        hash.update(chunk)
        const from = Math.max(offset, position)
        const to = Math.min(offset + length, position + read.bytesRead)
        if (to > from) {
          chunk.copy(page, copied, from - position, to - position)
          copied += to - from
        }
        position += read.bytesRead
      }
      if (position !== ref.bytes || copied !== length || hash.digest('hex') !== ref.sha256) {
        throw new Error(`recorder content integrity check failed: ${ref.sha256}`)
      }
    }
    const after = await handle.stat()
    if (contentIdentity(after) !== identity) {
      verifiedContent.delete(path)
      throw new Error(`recorder content integrity check failed: ${ref.sha256}`)
    }
    rememberVerified(path, identity)
  } finally {
    await handle.close()
  }
  const nextOffset = offset + length
  return {
    offset,
    nextOffset,
    totalBytes: ref.bytes,
    hasMore: nextOffset < ref.bytes,
    dataBase64: page.toString('base64')
  }
}

/** Ensure an archive owns a verified copy; an already-published target can recover without source. */
export async function copyRecorderContent(
  sourceRoot: string,
  targetRoot: string,
  ref: ToolContentRef
): Promise<void> {
  try {
    await readRecorderContent(targetRoot, ref)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const content = await readRecorderContent(sourceRoot, ref)
  const copied = await writeRecorderContent(targetRoot, content, ref.encoding)
  if (copied.sha256 !== ref.sha256 || copied.bytes !== ref.bytes) {
    throw new Error(`recorder content copy mismatch: ${ref.sha256}`)
  }
}
