import { constants, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { ProviderRunRequest } from './types'
import type { PiRunState } from './pi-types'
import { record } from './pi-shared'

// Historical bytes are excluded. Bound new bytes per prompt and header reads instead.
// If one prompt appends over 128MiB before its user entry, report unavailable; a future
// native byte-offset receipt can remove that limit without scanning arbitrary history.
const MAX_NEW_BYTES = 128 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
type ProofResult = { status: 'matched' | 'pending' } | { status: 'unavailable'; reason: string }

export function publishPersistedPiSession(request: ProviderRunRequest, state: PiRunState): void {
  if (!state.sessionId || state.persistedSessionId === state.sessionId || !state.sessionFile) return
  if (!statSync(state.sessionFile, { throwIfNoEntry: false })?.isFile()) return
  state.persistedSessionId = state.sessionId
  request.onExternalSessionId?.(state.persistedSessionId)
}

function exactPiUserText(content: unknown, expectedText: string, imageCount: number): boolean {
  if (content === expectedText) return true
  if (!Array.isArray(content)) return false
  const blocks = content.map(record)
  if (!blocks.every((block) =>
    (block.type === 'text' && typeof block.text === 'string') ||
    (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string')
  )) return false
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text as string).join('')
  if (text === expectedText) return true
  if (imageCount === 0 || blocks.filter((block) => block.type === 'image').length !== imageCount ||
    !text.startsWith(`${expectedText}\n\n`)) return false
  // Pi appends one dimension note per resized image. This fixed metadata is not a
  // user-text rewrite; the receipt's textHash does not claim image-byte equivalence.
  const notes = text.slice(expectedText.length + 2).split('\n')
  return notes.length <= imageCount && notes.every((note) => {
    const match = note.match(/^\[Image: original ([1-9]\d*)x([1-9]\d*), displayed at ([1-9]\d*)x([1-9]\d*)\. Multiply coordinates by (\d+\.\d{2}) to map to original image\.\]$/)
    return match !== null && (Number(match[1]) / Number(match[3])).toFixed(2) === match[5]
  })
}

export class PiSessionProof {
  private identity?: { dev: number; ino: number }
  private offset = 0
  private readBytes = 0
  private headerVerified = false
  private issue?: string
  private readonly decoder = new StringDecoder('utf8')
  private parts: string[] = []

  private constructor(
    private readonly path: string,
    private readonly sessionId: string,
    private readonly text: string,
    private readonly imageCount: number
  ) {}

  static async capture(path: string, sessionId: string, text: string, imageCount: number): Promise<PiSessionProof> {
    const proof = new PiSessionProof(path, sessionId, text, imageCount)
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        if (!info.isFile()) {
          proof.issue = 'Pi 会话目标不是普通文件，无法校验输入回执'
        } else {
          proof.identity = { dev: info.dev, ino: info.ino }
          proof.offset = info.size
          if (info.size > 0) {
            const last = Buffer.alloc(1)
            await file.read(last, 0, 1, info.size - 1)
            if (last[0] !== 10) proof.issue = 'Pi 会话在发送前存在未完成的 JSONL 行，无法冻结回执读取位置'
          }
        }
      } finally { await file.close() }
    } catch (error) {
      // A fresh Pi session need not exist until its first native message is persisted.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') proof.issue = `Pi 回执读取位置不可用：${String((error as Error).message)}`
    }
    return proof
  }

  async verify(entryId: string): Promise<ProofResult> {
    if (this.issue) return { status: 'unavailable', reason: this.issue }
    try {
      return await this.readEntry(entryId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.identity) return { status: 'pending' }
      return this.unavailable(`Pi 持久化输入回执无法读取：${String((error as Error).message)}`)
    }
  }

  private unavailable(reason: string): ProofResult {
    this.issue = reason
    this.parts = []
    return { status: 'unavailable', reason }
  }

  private async readEntry(entryId: string): Promise<ProofResult> {
    // O_NOFOLLOW retains the old symlink rejection without following a swapped target.
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile()) return this.unavailable('Pi 会话目标不是普通文件，无法校验输入回执')
      if (this.identity && (info.dev !== this.identity.dev || info.ino !== this.identity.ino)) {
        return this.unavailable('Pi 会话文件在发送后被替换，输入回执归属未知')
      }
      this.identity ??= { dev: info.dev, ino: info.ino }
      if (info.size < this.offset) return this.unavailable('Pi 会话文件在发送后被截断，输入回执归属未知')
      const buffer = Buffer.alloc(CHUNK_BYTES)
      if (!this.headerVerified) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK_BYTES, info.size), 0)
        const newline = buffer.subarray(0, bytesRead).indexOf(10)
        if (newline < 0) return bytesRead === CHUNK_BYTES
          ? this.unavailable('Pi 会话头超过 64KiB，无法校验输入回执')
          : { status: 'pending' }
        const header = record(JSON.parse(buffer.subarray(0, newline).toString('utf8')))
        if (header.type !== 'session' || header.id !== this.sessionId) return { status: 'pending' }
        this.headerVerified = true
      }
      // Each byte is consumed once across get_entries snapshots. A partially written
      // UTF-8/JSONL row is retained until the next native event, never parsed prematurely.
      while (this.offset < info.size) {
        if (this.readBytes === MAX_NEW_BYTES) return this.unavailable('Pi 本轮新增记录超过 128MiB，输入回执尚未校验')
        const length = Math.min(CHUNK_BYTES, info.size - this.offset, MAX_NEW_BYTES - this.readBytes)
        const { bytesRead } = await file.read(buffer, 0, length, this.offset)
        if (bytesRead === 0) return this.unavailable('Pi 会话文件在读取期间被截断，输入回执归属未知')
        this.offset += bytesRead
        this.readBytes += bytesRead
        const lines = this.decoder.write(buffer.subarray(0, bytesRead)).split('\n')
        for (let index = 0; index < lines.length - 1; index++) {
          this.parts.push(lines[index])
          const line = this.parts.join('')
          this.parts = []
          if (!line.trim()) continue
          const entry = record(JSON.parse(line))
          if (entry.id !== entryId) continue
          const message = record(entry.message)
          return { status: entry.type === 'message' && message.role === 'user' &&
            exactPiUserText(message.content, this.text, this.imageCount) ? 'matched' : 'pending' }
        }
        this.parts.push(lines[lines.length - 1])
      }
      return { status: 'pending' }
    } finally { await file.close() }
  }
}
