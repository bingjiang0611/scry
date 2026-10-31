import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isToolContentRef, type ToolContentRef } from '../../shared/tool-content.js'
import { syncDirectory, writeFileAtomicExclusive, writeFileAtomicExclusiveBatch, writeFileAtomicExclusiveCopies } from './io.js'

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

function assertContentBytes(existing: Buffer, expected: Buffer, sha256: string): void {
  if (!existing.equals(expected)) throw new Error(`recorder content collision or corruption: ${sha256}`)
}

async function verifyAndSyncContent(path: string, existing: Buffer, expected: Buffer, sha256: string): Promise<void> {
  assertContentBytes(existing, expected, sha256)
  await syncDirectory(dirname(path))
}

export async function writeRecorderContent(
  dataRoot: string,
  content: string,
  encoding: ToolContentRef['encoding']
): Promise<ToolContentRef> {
  const bytes = Buffer.from(content, 'utf8')
  const sha256 = digest(bytes)
  const path = contentPath(dataRoot, sha256)
  const ref: ToolContentRef = { storage: 'recorder-content-v1', sha256, bytes: bytes.length, encoding }
  let existing: Buffer
  try {
    existing = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await writeFileAtomicExclusive(path, bytes)
      return ref
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
      // Another publisher won after our read. Verify its bytes just like an existing blob.
      existing = await readFile(path)
    }
  }
  // Incoming bytes already determine the address; compare complete payloads without hashing twice.
  // Reuse must still sync the link: a previous publisher may have failed its final directory sync.
  await verifyAndSyncContent(path, existing, bytes, sha256)
  return ref
}

/** Publish one already-held snapshot without retaining all UTF-8 buffers or caching directory proof. */
export async function writeRecorderContentBatch(
  dataRoot: string,
  contents: readonly string[],
  encoding: ToolContentRef['encoding']
): Promise<ToolContentRef[]> {
  const refs: ToolContentRef[] = []
  const seen = new Map<string, string>()
  const missing: Array<{ path: string; content: string; sha256: string }> = []
  for (const content of contents) {
    const bytes = Buffer.from(content, 'utf8')
    const sha256 = digest(bytes)
    const path = contentPath(dataRoot, sha256)
    refs.push({ storage: 'recorder-content-v1', sha256, bytes: bytes.length, encoding })
    const previous = seen.get(path)
    if (previous !== undefined) {
      assertContentBytes(Buffer.from(previous, 'utf8'), bytes, sha256)
      continue
    }
    seen.set(path, content)
    let existing: Buffer
    try {
      existing = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push({ path, content, sha256 })
      continue
    }
    await verifyAndSyncContent(path, existing, bytes, sha256)
  }
  const outcomes = await writeFileAtomicExclusiveBatch(missing)
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome !== 'existing') continue
    const entry = missing[index]
    await verifyAndSyncContent(entry.path, await readFile(entry.path), Buffer.from(entry.content, 'utf8'), entry.sha256)
  }
  return refs
}

/** Publish one payload to every authority before exposing its reference. */
export async function writeRecorderContentCopies(
  dataRoots: readonly [string, ...string[]],
  content: string,
  encoding: ToolContentRef['encoding']
): Promise<ToolContentRef> {
  if (dataRoots.length === 1) return writeRecorderContent(dataRoots[0], content, encoding)
  const bytes = Buffer.from(content, 'utf8')
  const sha256 = digest(bytes)
  const paths = [...new Set(dataRoots.map(root => contentPath(root, sha256)))]
  const missing: string[] = []
  for (const path of paths) {
    let existing: Buffer
    try {
      existing = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(path)
      continue
    }
    await verifyAndSyncContent(path, existing, bytes, sha256)
  }
  const outcomes = await writeFileAtomicExclusiveCopies(missing, bytes)
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome === 'existing') {
      // A competing publisher won after the initial read. EEXIST alone proves nothing.
      await verifyAndSyncContent(missing[index], await readFile(missing[index]), bytes, sha256)
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
