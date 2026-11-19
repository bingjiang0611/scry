import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from './canonical-json'
import { INLINE_BODY_MAX_BYTES, OrchestrationStoreError, type PreparedBody } from './types'

const SHA256_RE = /^[0-9a-f]{64}$/

function fsyncDirectory(dir: string): void {
  let fd: number | null = null
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Some filesystems do not support fsync on directory descriptors; ignore only there.
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Content-addressed body store (data §4.7).
 * Bodies <= 16 KiB stay inline in `orch_outbox.payload`; larger bodies are written
 * synchronously with file + directory fsync to `<orchestrationDir>/bodies/<sha256>` (0600).
 */
export class BodyStore {
  readonly bodiesDir: string

  constructor(orchestrationDir: string) {
    this.bodiesDir = join(orchestrationDir, 'bodies')
  }

  private ensureDir(): void {
    mkdirSync(this.bodiesDir, { recursive: true, mode: 0o700 })
    chmodSync(this.bodiesDir, 0o700)
  }

  externalPath(sha256: string): string {
    if (!SHA256_RE.test(sha256)) {
      throw new OrchestrationStoreError('orchestration_body_corrupt', `Invalid body sha256: ${sha256}`)
    }
    return join(this.bodiesDir, sha256)
  }

  hasExternalBody(sha256: string): boolean {
    if (!SHA256_RE.test(sha256)) return false
    return existsSync(this.externalPath(sha256))
  }

  prepareBody(content: string | Buffer): PreparedBody {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const bytes = buffer.byteLength
    const sha256 = sha256Hex(buffer)

    if (bytes <= INLINE_BODY_MAX_BYTES) {
      return {
        storage: 'inline',
        sha256,
        bytes,
        inline: typeof content === 'string' ? content : buffer.toString('utf8')
      }
    }

    this.ensureDir()
    const targetPath = this.externalPath(sha256)
    if (existsSync(targetPath)) {
      chmodSync(targetPath, 0o600)
      return { storage: 'external', sha256, bytes }
    }

    const tmpPath = join(this.bodiesDir, `.tmp-${sha256}-${randomUUID()}`)
    const fd = openSync(tmpPath, 'wx', 0o600)
    try {
      let offset = 0
      while (offset < buffer.byteLength) {
        offset += writeSync(fd, buffer, offset, buffer.byteLength - offset)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, targetPath)
    chmodSync(targetPath, 0o600)
    fsyncDirectory(this.bodiesDir)

    return { storage: 'external', sha256, bytes }
  }

  readBody(ref: PreparedBody): Buffer {
    const data =
      ref.storage === 'inline'
        ? Buffer.from(ref.inline ?? '', 'utf8')
        : readFileSync(this.externalPath(ref.sha256))
    const actualSha = sha256Hex(data)
    if (actualSha !== ref.sha256 || data.byteLength !== ref.bytes) {
      throw new OrchestrationStoreError(
        'orchestration_body_corrupt',
        `Body digest/size mismatch for ${ref.sha256}`
      )
    }
    return data
  }

  unlinkBody(sha256: string): void {
    if (!SHA256_RE.test(sha256)) return
    rmSync(this.externalPath(sha256), { force: true })
  }
}
