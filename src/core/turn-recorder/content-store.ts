import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isToolContentRef, type ToolContentRef } from '../../shared/tool-content.js'
import { writeFileAtomicExclusive } from './io.js'

function contentPath(dataRoot: string, sha256: string): string {
  return join(dataRoot, 'content', 'sha256', sha256.slice(0, 2), `${sha256}.bin`)
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
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
