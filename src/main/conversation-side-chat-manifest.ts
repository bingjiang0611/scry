import { createHash } from 'node:crypto'
import { readRecorderContent, writeRecorderContent } from '../core/turn-recorder/content-store'
import type { ToolContentRef } from '../shared/tool-content'
import { sideChatSnapshotRunId } from '../shared/conversation'
import { Utf8ChunkNormalizer } from './utf8-chunks'
import {
  isManifestRef, manifestBinding, readManifestByteRange, readManifestEntry, readManifestRange,
  ManifestWriter, type ManifestEntry, type ManifestRef
} from './content-manifest'

/**
 * Format 4 of a side-chat snapshot: the item list and every message body live outside
 * the conversation record in content-addressed manifests.
 *
 * Format 3 stored one JSON artifact holding every message, which forced byte and item
 * caps so that artifact and its parser stayed affordable. Here the record keeps only a
 * descriptor (root reference, counts, byte totals), a message body is a manifest of
 * bounded UTF-8 parts written while the source is streamed, and one item lookup reads
 * O(height + fanout) nodes instead of the whole history.
 */
export const SIDE_CHAT_SNAPSHOT_FORMAT = 4
/** One stored text part: at most one bounded reader page, never one whole history. */
export const SIDE_CHAT_PART_BYTES = 256 * 1024
/** Messages at or below this size live inside their item entry instead of a part manifest. */
export const SIDE_CHAT_INLINE_BYTES = 2048
const hashPattern = /^[a-f0-9]{64}$/

export interface SideChatMessageRef {
  runId: string
  itemId: string
  contentHash: string
}

export type SideChatMessageBody =
  | { store: 'text'; text: string }
  | { store: 'parts'; root: ManifestRef }

/**
 * One frozen message reference. The non-body fields are the same evidence format 3
 * stored beside each message, so a handoff artifact keeps its provenance.
 */
export interface SideChatManifestItem extends ManifestEntry {
  ref: SideChatMessageRef
  /** Source turn ordinal; two messages of one turn share it. */
  sourceOrdinal: number
  providerId: string
  role: 'user' | 'assistant'
  status: string
  delivery: string
  nativeSessionId?: string
  providerTurnId?: string
  body: SideChatMessageBody
}

export interface SideChatSnapshotDescriptor {
  format: typeof SIDE_CHAT_SNAPSHOT_FORMAT
  id: string
  prefixFingerprint: string
  throughOrdinal: number
  throughRunId: string
  capturedAt: number
  messageCount: number
  bodyBytes: number
  items: ManifestRef
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), '侧聊快照必须是对象')
  return value as Record<string, unknown>
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Decodes the longest prefix of `bytes` that ends on a character boundary.
 *
 * A stored part boundary is already a character boundary, but a page offset chosen by a
 * caller need not be, so a page never ends or starts inside one character.
 */
const utf8 = new TextDecoder('utf-8', { fatal: true })

function decodePrefix(bytes: Buffer): { data: string; consumed: number } {
  let end = bytes.length
  for (let attempt = 0; attempt < 4 && end > 0; attempt += 1) {
    try {
      return { data: utf8.decode(bytes.subarray(0, end)), consumed: end }
    } catch {
      end -= 1
    }
  }
  return { data: '', consumed: 0 }
}

/** Bounded body writer: hashes the whole message while publishing one part at a time. */
class MessageBodyWriter {
  private readonly parts: ManifestWriter
  private readonly hash = createHash('sha256')
  private readonly small: string[] = []
  private readonly normalizer = new Utf8ChunkNormalizer()
  private buffer = ''
  private bufferedBytes = 0
  private bytes = 0
  private smallBytes = 0
  private smallFits = true

  constructor(private readonly dataRoot: string, binding: string) {
    this.parts = new ManifestWriter(dataRoot, binding)
  }

  async push(chunk: string): Promise<void> {
    // A pair split across chunks must be hashed and counted as one character.
    const text = this.normalizer.push(chunk)
    if (text.length > 0) await this.accept(text)
  }

  private async accept(chunk: string): Promise<void> {
    this.hash.update(chunk, 'utf8')
    const bytes = Buffer.byteLength(chunk, 'utf8')
    this.bytes += bytes
    if (this.smallFits) {
      this.smallBytes += bytes
      if (this.smallBytes <= SIDE_CHAT_INLINE_BYTES) this.small.push(chunk)
      else { this.smallFits = false; this.small.length = 0 }
    }
    this.buffer += chunk
    this.bufferedBytes += bytes
    while (this.bufferedBytes >= SIDE_CHAT_PART_BYTES) {
      const cut = this.cut()
      if (cut === 0) break
      await this.emit(this.buffer.slice(0, cut))
      this.buffer = this.buffer.slice(cut)
      this.bufferedBytes = Buffer.byteLength(this.buffer, 'utf8')
    }
  }

  async seal(): Promise<{ contentHash: string; bytes: number; body: SideChatMessageBody }> {
    const tail = this.normalizer.flush()
    if (tail.length > 0) await this.accept(tail)
    if (this.buffer.length > 0 && this.bytes > SIDE_CHAT_INLINE_BYTES) await this.emit(this.buffer)
    this.buffer = ''
    this.bufferedBytes = 0
    const contentHash = this.hash.digest('hex')
    if (this.bytes <= SIDE_CHAT_INLINE_BYTES) {
      return { contentHash, bytes: this.bytes, body: { store: 'text', text: this.small.join('') } }
    }
    return { contentHash, bytes: this.bytes, body: { store: 'parts', root: await this.parts.seal() } }
  }

  private async emit(text: string): Promise<void> {
    const ref = await writeRecorderContent(this.dataRoot, text, 'utf8')
    await this.parts.append({ bytes: Buffer.byteLength(text, 'utf8'), ref })
  }

  /** Largest prefix of the buffer inside one part, never splitting a surrogate pair. */
  private cut(): number {
    let low = 0
    let high = this.buffer.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(this.buffer.slice(0, middle), 'utf8') <= SIDE_CHAT_PART_BYTES) low = middle
      else high = middle - 1
    }
    const code = this.buffer.charCodeAt(low - 1)
    return code >= 0xd800 && code <= 0xdbff ? Math.max(0, low - 1) : low
  }
}

export interface SideChatSnapshotIdentity {
  id: string
  prefixFingerprint: string
  throughOrdinal: number
  throughRunId: string
  capturedAt: number
}

export interface SideChatSnapshotWriterOptions {
  dataRoot: string
  identity: SideChatSnapshotIdentity
}

/**
 * Seals messages in source order. Each message is stored as it arrives, so a single
 * huge visible message is never assembled before it can be written, and its hash is
 * exact because it is computed over every chunk as it streams.
 */
export class SideChatSnapshotWriter {
  private readonly items: ManifestWriter
  private readonly binding: string
  private count = 0
  private bodyBytes = 0
  private lastOrdinal = 0

  constructor(private readonly options: SideChatSnapshotWriterOptions) {
    this.binding = manifestBinding(options.identity.id, options.identity.prefixFingerprint)
    this.items = new ManifestWriter(options.dataRoot, this.binding)
  }

  /** `text` may be a string or a stream; a huge message must be passed as a stream. */
  async appendMessage(
    entry: {
      ref: SideChatMessageRef
      sourceOrdinal: number
      providerId: string
      role: 'user' | 'assistant'
      status: string
      delivery: string
      nativeSessionId?: string
      providerTurnId?: string
    },
    text: AsyncIterable<string> | string
  ): Promise<void> {
    if (!Number.isSafeInteger(entry.sourceOrdinal) || entry.sourceOrdinal < this.lastOrdinal ||
      entry.sourceOrdinal <= 0) {
      throw new Error('侧聊快照消息顺序无效')
    }
    this.lastOrdinal = entry.sourceOrdinal
    const writer = new MessageBodyWriter(this.options.dataRoot, this.binding)
    if (typeof text === 'string') await writer.push(text)
    else for await (const chunk of text) await writer.push(chunk)
    const sealed = await writer.seal()
    if (sealed.contentHash !== entry.ref.contentHash) throw new Error('侧聊快照消息正文与引用哈希不一致')
    await this.items.append({
      ref: entry.ref, sourceOrdinal: entry.sourceOrdinal, providerId: entry.providerId,
      role: entry.role, status: entry.status, delivery: entry.delivery,
      ...(entry.nativeSessionId !== undefined ? { nativeSessionId: entry.nativeSessionId } : {}),
      ...(entry.providerTurnId !== undefined ? { providerTurnId: entry.providerTurnId } : {}),
      bytes: sealed.bytes, body: sealed.body
    })
    this.count += 1
    this.bodyBytes += sealed.bytes
  }

  async seal(): Promise<SideChatSnapshotDescriptor> {
    if (this.count === 0 || this.lastOrdinal !== this.options.identity.throughOrdinal) {
      throw new Error('侧聊快照截止轮次与消息顺序不一致')
    }
    return {
      format: SIDE_CHAT_SNAPSHOT_FORMAT,
      ...this.options.identity,
      messageCount: this.count,
      bodyBytes: this.bodyBytes,
      items: await this.items.seal()
    }
  }
}

/** The descriptor kept in the conversation record is validated in main, never trusted. */
export function assertSideChatSnapshotDescriptor(value: unknown): asserts value is SideChatSnapshotDescriptor {
  const descriptor = object(value)
  requireValue(Object.keys(descriptor).every(key => [
    'format', 'id', 'prefixFingerprint', 'throughOrdinal', 'throughRunId', 'capturedAt',
    'messageCount', 'bodyBytes', 'items'
  ].includes(key)), '侧聊快照字段不受支持')
  requireValue(descriptor.format === SIDE_CHAT_SNAPSHOT_FORMAT, '侧聊快照格式不受支持')
  requireValue(typeof descriptor.id === 'string' && /^[a-f0-9-]{36}$/i.test(descriptor.id), '侧聊快照 ID 无效')
  requireValue(typeof descriptor.prefixFingerprint === 'string' && hashPattern.test(descriptor.prefixFingerprint), '侧聊前缀指纹无效')
  requireValue(isCount(descriptor.throughOrdinal) && descriptor.throughOrdinal > 0, '侧聊快照截止轮次无效')
  requireValue(typeof descriptor.throughRunId === 'string' && descriptor.throughRunId.length > 0, '侧聊快照截止轮次缺少运行身份')
  requireValue(isCount(descriptor.capturedAt) && descriptor.capturedAt > 0, '侧聊快照冻结时间无效')
  requireValue(isCount(descriptor.messageCount) && descriptor.messageCount > 0, '侧聊快照消息数量无效')
  requireValue(isCount(descriptor.bodyBytes) && descriptor.bodyBytes > 0, '侧聊快照正文字节数无效')
  requireValue(isManifestRef(descriptor.items), '侧聊快照清单引用无效')
  requireValue(descriptor.items.count === descriptor.messageCount, '侧聊快照清单条目数与消息数量不一致')
  requireValue(descriptor.items.bytes === descriptor.bodyBytes, '侧聊快照清单字节数与正文字节数不一致')
}

function bindingOf(descriptor: SideChatSnapshotDescriptor): string {
  return manifestBinding(descriptor.id, descriptor.prefixFingerprint)
}

function assertItem(value: ManifestEntry, index: number, descriptor: SideChatSnapshotDescriptor): SideChatManifestItem {
  const item = value as unknown as Record<string, unknown>
  requireValue(Object.keys(item).every(key => [
    'ref', 'sourceOrdinal', 'providerId', 'role', 'status', 'delivery',
    'nativeSessionId', 'providerTurnId', 'bytes', 'body'
  ].includes(key)), '侧聊快照消息字段不受支持')
  const ref = object(item.ref)
  requireValue(Object.keys(ref).length === 3 && typeof ref.runId === 'string' && typeof ref.contentHash === 'string' &&
    hashPattern.test(ref.contentHash), '侧聊快照消息引用无效')
  requireValue(ref.runId === sideChatSnapshotRunId(descriptor.id, index), '侧聊快照消息运行身份不匹配')
  requireValue(item.role === 'user' || item.role === 'assistant', '侧聊快照消息角色无效')
  requireValue(ref.itemId === item.role, '侧聊快照消息引用与角色不一致')
  requireValue(isCount(item.sourceOrdinal) && item.sourceOrdinal > 0, '侧聊快照消息顺序无效')
  requireValue(typeof item.providerId === 'string' && item.providerId.length > 0, '侧聊快照消息 Provider 无效')
  requireValue(typeof item.status === 'string' && typeof item.delivery === 'string', '侧聊快照消息状态无效')
  requireValue(item.nativeSessionId === undefined || typeof item.nativeSessionId === 'string', '侧聊快照消息会话身份无效')
  requireValue(item.providerTurnId === undefined || typeof item.providerTurnId === 'string', '侧聊快照消息轮次身份无效')
  requireValue(isCount(item.bytes), '侧聊快照消息字节数无效')
  const body = object(item.body)
  if (body.store === 'text') {
    requireValue(Object.keys(body).length === 2 && typeof body.text === 'string', '侧聊快照内联正文无效')
    requireValue(Buffer.byteLength(body.text, 'utf8') === item.bytes, '侧聊快照内联正文与字节数不一致')
    requireValue(createHash('sha256').update(body.text, 'utf8').digest('hex') === ref.contentHash, '侧聊快照内联正文哈希不一致')
  } else {
    requireValue(body.store === 'parts' && Object.keys(body).length === 2, '侧聊快照正文存储类型无效')
    requireValue(isManifestRef(body.root), '侧聊快照正文清单引用无效')
    requireValue((body.root as ManifestRef).bytes === item.bytes, '侧聊快照正文清单字节数与消息不一致')
  }
  return value as unknown as SideChatManifestItem
}

export async function readSideChatManifestItem(
  dataRoot: string,
  descriptor: SideChatSnapshotDescriptor,
  index: number
): Promise<SideChatManifestItem> {
  assertSideChatSnapshotDescriptor(descriptor)
  if (!Number.isSafeInteger(index) || index < 0 || index >= descriptor.messageCount) {
    throw new Error('侧聊快照消息位置越界')
  }
  const entry = await readManifestEntry(dataRoot, descriptor.items, index, bindingOf(descriptor))
  return assertItem(entry, index, descriptor)
}

/** One viewer page of item metadata: only the leaves it covers are read. */
export async function readSideChatManifestItems(
  dataRoot: string,
  descriptor: SideChatSnapshotDescriptor,
  from: number,
  count: number
): Promise<SideChatManifestItem[]> {
  assertSideChatSnapshotDescriptor(descriptor)
  const entries = await readManifestRange(dataRoot, descriptor.items, from, count, bindingOf(descriptor))
  return entries.map((entry, offset) => assertItem(entry, from + offset, descriptor))
}

export interface SideChatMessagePage {
  text: string
  /** Byte offset where the next page starts; equal to the message size at the end. */
  nextOffset: number
  totalBytes: number
  hasMore: boolean
}

/**
 * One byte-addressed page of a frozen message.
 *
 * A huge assistant message is stored as bounded parts, so this reads the parts the range
 * touches instead of rebuilding the message, and it never splits a character.
 */
export async function readSideChatMessagePage(
  dataRoot: string,
  descriptor: SideChatSnapshotDescriptor,
  index: number,
  offset: number,
  limit: number
): Promise<SideChatMessagePage> {
  const item = await readSideChatManifestItem(dataRoot, descriptor, index)
  return readSideChatItemBodyPage(dataRoot, descriptor, item, offset, limit)
}

/**
 * One page of an item whose metadata the caller already read, so paging a viewer does
 * not fetch the same index leaf once per row.
 */
export async function readSideChatItemBodyPage(
  dataRoot: string,
  descriptor: SideChatSnapshotDescriptor,
  item: SideChatManifestItem,
  offset: number,
  limit: number
): Promise<SideChatMessagePage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('侧聊正文游标无效')
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('侧聊正文分页大小无效')
  if (offset > item.bytes) throw new Error('侧聊正文游标已越界')
  if (item.body.store === 'text') {
    const bytes = Buffer.from(item.body.text, 'utf8')
    const start = offset + skipPartialLead(bytes.subarray(offset))
    const decoded = decodePrefix(bytes.subarray(start, start + limit))
    if (decoded.consumed === 0 && start < bytes.length) throw new Error('侧聊正文本页装不下一个字符')
    const nextOffset = start + decoded.consumed
    return { text: decoded.data, nextOffset, totalBytes: bytes.length, hasMore: nextOffset < bytes.length }
  }
  const parts = await readParts(dataRoot, descriptor, item, offset, limit)
  const local = Math.max(0, offset - parts.base)
  const start = local + skipPartialLead(parts.buffer.subarray(local))
  const decoded = decodePrefix(parts.buffer.subarray(start, start + limit))
  if (decoded.consumed === 0 && parts.base + start < item.bytes) throw new Error('侧聊正文本页装不下一个字符')
  const nextOffset = Math.min(item.bytes, parts.base + start + decoded.consumed)
  return { text: decoded.data, nextOffset, totalBytes: item.bytes, hasMore: nextOffset < item.bytes }
}

/** Byte offset of the first continuation byte; a page never starts inside a character. */
function skipPartialLead(bytes: Buffer): number {
  let skip = 0
  while (skip < 3 && skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip += 1
  return skip
}

/** Concatenates only the parts overlapping the requested range, plus a character lookahead. */
async function readParts(
  dataRoot: string,
  descriptor: SideChatSnapshotDescriptor,
  item: SideChatManifestItem,
  offset: number,
  limit: number
): Promise<{ buffer: Buffer; base: number }> {
  if (item.body.store !== 'parts') return { buffer: Buffer.alloc(0), base: offset }
  const end = Math.min(item.bytes, offset + limit + 4)
  const slices = await readManifestByteRange(dataRoot, item.body.root, offset, end - offset, bindingOf(descriptor))
  const chunks: Buffer[] = []
  for (const slice of slices) {
    const ref = (slice.entry as { ref?: ToolContentRef }).ref
    if (!ref) throw new Error('侧聊正文分片引用无效')
    const text = await readRecorderContent(dataRoot, ref)
    if (Buffer.byteLength(text, 'utf8') !== slice.entry.bytes) throw new Error('侧聊正文分片字节数不一致')
    chunks.push(Buffer.from(text, 'utf8'))
  }
  return { buffer: Buffer.concat(chunks), base: slices[0]?.start ?? offset }
}
