import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readRecorderContent } from '../core/turn-recorder/content-store'
import { sideChatSnapshotRunId } from '../shared/conversation'
import { MANIFEST_FANOUT, MANIFEST_NODE_BYTES, type ManifestRef } from './content-manifest'
import {
  SIDE_CHAT_PART_BYTES, SideChatSnapshotWriter, assertSideChatSnapshotDescriptor,
  readSideChatManifestItem, readSideChatManifestItems, readSideChatMessagePage,
  type SideChatSnapshotDescriptor
} from './conversation-side-chat-manifest'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const snapshotId = '11111111-1111-4111-8111-111111111111'
const fingerprint = sha('prefix')

let dataRoot: string | undefined
/** One durable seal at scale is shared: 4500 items cost 147 content writes, each fsynced. */
let largeRoot: string
let large: SideChatSnapshotDescriptor

beforeAll(async () => {
  largeRoot = await mkdtemp(join(tmpdir(), 'scry-manifest-large-'))
  large = await sealMany(largeRoot, 4500)
}, 120_000)

afterAll(async () => {
  await rm(largeRoot, { recursive: true, force: true })
})

afterEach(async () => {
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
  dataRoot = undefined
})

async function root(): Promise<string> {
  dataRoot = await mkdtemp(join(tmpdir(), 'scry-manifest-'))
  return dataRoot
}

function contentFile(rootDir: string, sha256: string): string {
  return join(rootDir, 'content', 'sha256', sha256.slice(0, 2), `${sha256}.bin`)
}

interface ItemEntry {
  ref: { runId: string; itemId: string; contentHash: string }
  sourceOrdinal: number
  providerId: string
  role: 'user' | 'assistant'
  status: string
  delivery: string
}

async function item(index: number): Promise<ItemEntry> {
  const text = `消息 ${index}`
  const role = index % 2 === 0 ? 'assistant' : 'user'
  return {
    ref: { runId: sideChatSnapshotRunId(snapshotId, index - 1), itemId: role, contentHash: sha(text) },
    sourceOrdinal: index, providerId: 'claude', role, status: 'completed', delivery: 'accepted'
  }
}

async function messageText(index: number): Promise<string> {
  return `消息 ${index}`
}

async function sealMany(dir: string, count: number): Promise<SideChatSnapshotDescriptor> {
  const writer = new SideChatSnapshotWriter({
    dataRoot: dir,
    identity: { id: snapshotId, prefixFingerprint: fingerprint, throughOrdinal: count, throughRunId: `run-${count}`, capturedAt: 1 }
  })
  for (let index = 1; index <= count; index += 1) {
    await writer.appendMessage(await item(index), await messageText(index))
  }
  return writer.seal()
}

describe('side-chat snapshot manifests', () => {
  it('indexes more than 4000 items without a flat reference list', async () => {
    const dir = largeRoot
    const descriptor = large
    expect(descriptor.messageCount).toBe(4500)
    expect(descriptor.items.count).toBe(4500)
    // 4500 / 32 leaves needs more than one branch level: the index is a real tree.
    const top = JSON.parse(await readRecorderContent(dir, descriptor.items.root)) as { kind: string }
    expect(top.kind).toBe('branch')
    const last = await readSideChatManifestItem(dir, descriptor, 4499)
    expect(last.sourceOrdinal).toBe(4500)
    const page = await readSideChatManifestItems(dir, descriptor, 2200, 40)
    expect(page.map(entry => entry.sourceOrdinal)).toEqual(Array.from({ length: 40 }, (_unused, offset) => 2201 + offset))
  })

  it('stores one huge message as bounded parts and pages it back exactly', async () => {
    const dir = await root()
    const text = `${'a'.repeat(5 * 1024 * 1024 - 4)}😀尾`
    const bytes = Buffer.byteLength(text, 'utf8')
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024)
    const writer = new SideChatSnapshotWriter({
      dataRoot: dir,
      identity: { id: snapshotId, prefixFingerprint: fingerprint, throughOrdinal: 1, throughRunId: 'run-1', capturedAt: 1 }
    })
    async function* chunks(): AsyncGenerator<string> {
      for (let offset = 0; offset < text.length; offset += 8192) yield text.slice(offset, offset + 8192)
    }
    await writer.appendMessage({
      ref: { runId: sideChatSnapshotRunId(snapshotId, 0), itemId: 'assistant', contentHash: sha(text) },
      sourceOrdinal: 1, providerId: 'claude', role: 'assistant', status: 'completed', delivery: 'accepted'
    }, chunks())
    const descriptor = await writer.seal()
    expect(descriptor.bodyBytes).toBe(bytes)
    const stored = await readSideChatManifestItem(dir, descriptor, 0)
    if (stored.body.store !== 'parts') throw new Error('huge message must be stored as parts')
    expect(stored.body.root.count).toBe(Math.ceil(bytes / SIDE_CHAT_PART_BYTES))
    expect(stored.body.root.root.bytes).toBeLessThanOrEqual(MANIFEST_NODE_BYTES)

    const pages: string[] = []
    let offset = 0
    for (;;) {
      const page = await readSideChatMessagePage(dir, descriptor, 0, offset, SIDE_CHAT_PART_BYTES)
      pages.push(page.text)
      expect(page.totalBytes).toBe(bytes)
      if (!page.hasMore) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
    expect(pages.join('')).toBe(text)
  })

  it('never splits a character across pages', async () => {
    const dir = await root()
    const blocks: Array<{ text: string; limit: number }> = [
      { text: '😀'.repeat(20_000), limit: 4093 },
      { text: '😀'.repeat(10), limit: 5 }
    ]
    for (const block of blocks) {
      const writer = new SideChatSnapshotWriter({
        dataRoot: dir,
        identity: {
          id: snapshotId, prefixFingerprint: fingerprint,
          throughOrdinal: 1, throughRunId: 'run-1', capturedAt: 1
        }
      })
      await writer.appendMessage({
        ref: { runId: sideChatSnapshotRunId(snapshotId, 0), itemId: 'assistant', contentHash: sha(block.text) },
        sourceOrdinal: 1, providerId: 'claude', role: 'assistant', status: 'completed', delivery: 'accepted'
      }, block.text)
      const descriptor = await writer.seal()
      const chunks: string[] = []
      let offset = 0
      for (;;) {
        const page = await readSideChatMessagePage(dir, descriptor, 0, offset, block.limit)
        chunks.push(page.text)
        expect(page.text).not.toContain('\ufffd')
        expect(Buffer.byteLength(page.text, 'utf8')).toBeLessThanOrEqual(block.limit)
        if (!page.hasMore) break
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
      }
      expect(chunks.join('')).toBe(block.text)
    }
  })

  it('hashes a message whose surrogate pair is split across input chunks', async () => {
    const dir = await root()
    const cases = [
      // Small enough to be stored inline, so the inline text path is proved too.
      { text: `前缀🙂后缀`, chunks: ['前缀\ud83d', '\ude42后缀'] },
      // Beyond one part, so the split also crosses the inline/parts threshold.
      { text: `${'a'.repeat(SIDE_CHAT_PART_BYTES - 1)}🙂尾`, chunks: null as string[] | null }
    ]
    let expectedOrdinal = 1
    for (const block of cases) {
      const text = block.text
      const chunks = block.chunks ?? (() => {
        // Cut at the lone high surrogate so the pair spans two pushed chunks.
        const split = text.indexOf('\ud83d') + 1
        const pieces: string[] = []
        for (let offset = 0; offset < text.length; offset += 1024) pieces.push(text.slice(offset, offset + 1024))
        pieces.splice(0, pieces.length, text.slice(0, split), text.slice(split))
        return pieces
      })()
      const writer = new SideChatSnapshotWriter({
        dataRoot: dir,
        identity: {
          id: snapshotId, prefixFingerprint: fingerprint,
          throughOrdinal: expectedOrdinal, throughRunId: `run-${expectedOrdinal}`, capturedAt: 1
        }
      })
      async function* stream(): AsyncGenerator<string> {
        for (const chunk of chunks) yield chunk
      }
      await writer.appendMessage({
        ref: { runId: sideChatSnapshotRunId(snapshotId, 0), itemId: 'assistant', contentHash: sha(text) },
        sourceOrdinal: expectedOrdinal, providerId: 'claude', role: 'assistant', status: 'completed', delivery: 'accepted'
      }, stream())
      const descriptor = await writer.seal()
      // The seal above only succeeds when the streamed digest equals the whole-string hash.
      expect(descriptor.bodyBytes).toBe(Buffer.byteLength(text, 'utf8'))
      const stored = await readSideChatManifestItem(dir, descriptor, 0)
      expect(stored.ref.contentHash).toBe(sha(text))
      expect(stored.bytes).toBe(Buffer.byteLength(text, 'utf8'))
      const pages: string[] = []
      let offset = 0
      for (;;) {
        const page = await readSideChatMessagePage(dir, descriptor, 0, offset, 4093)
        pages.push(page.text)
        if (!page.hasMore) break
        offset = page.nextOffset
      }
      expect(pages.join('')).toBe(text)
      expectedOrdinal += 1
    }
  })

  it('refuses a correctly hashed leaf whose count disagrees with its entries', async () => {
    const dir = await root()
    const descriptor = await sealMany(dir, 2)
    const original = JSON.parse(await readRecorderContent(dir, descriptor.items.root)) as {
      kind: string; count: number; entries: unknown[]
    }
    expect(original.kind).toBe('leaf')
    // Rehash after lying about the count, so the content reference itself is still valid:
    // only the index invariant can catch this, not an integrity check.
    const tampered = { ...original, count: 3 }
    const body = JSON.stringify(tampered)
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex')
    await mkdir(dirname(contentFile(dir, sha256)), { recursive: true })
    await writeFile(contentFile(dir, sha256), body)
    const lying: SideChatSnapshotDescriptor = {
      ...descriptor,
      messageCount: 3,
      items: {
        ...descriptor.items, count: 3,
        root: { ...descriptor.items.root, sha256 }
      }
    }
    await expect(readSideChatManifestItem(dir, lying, 0)).rejects.toThrow('清单叶子计数与条目数量不一致')
    // A parent that claims the same wrong count cannot make the leaf readable either.
    await expect(readSideChatManifestItems(dir, lying, 0, 3)).rejects.toThrow('清单叶子计数与条目数量不一致')
  })

  it('reads one item without touching unrelated index nodes', async () => {
    const dir = await root()
    const descriptor = await sealMany(dir, 300)
    const leaf = await lastLeaf(dir, descriptor.items, 299)
    await writeFile(contentFile(dir, leaf.sha256), 'tampered')
    // The first leaf was never read, so item 0 is still readable.
    expect((await readSideChatManifestItem(dir, descriptor, 0)).sourceOrdinal).toBe(1)
    await expect(readSideChatManifestItem(dir, descriptor, 299)).rejects.toThrow(/integrity check failed/)
  })

  it('refuses an item list that belongs to another snapshot', async () => {
    const dir = await root()
    const descriptor = await sealMany(dir, 40)
    const other: SideChatSnapshotDescriptor = { ...descriptor, id: '22222222-2222-4222-8222-222222222222' }
    await expect(readSideChatManifestItem(dir, other, 0)).rejects.toThrow('不属于当前快照来源')
  })

  it('rejects a descriptor that cannot be a format 4 snapshot', async () => {
    const dir = await root()
    const descriptor = await sealMany(dir, 2)
    expect(() => assertSideChatSnapshotDescriptor({ ...descriptor, messageCount: 3 })).toThrow('条目数与消息数量不一致')
    expect(() => assertSideChatSnapshotDescriptor({ ...descriptor, format: 3 })).toThrow('格式不受支持')
    expect(() => assertSideChatSnapshotDescriptor({ ...descriptor, items: { ...descriptor.items, count: 0 } })).toThrow('清单引用无效')
  })
})

/** Test-only descent to the leaf covering one index, using the public content references. */
async function lastLeaf(dir: string, manifest: ManifestRef, index: number): Promise<{ sha256: string }> {
  let node = JSON.parse(await readRecorderContent(dir, manifest.root)) as {
    kind: string
    children?: Array<{ ref: { sha256: string }; from: number; count: number; bytes: number }>
  }
  for (;;) {
    const children = node.children ?? []
    expect(children.length).toBeLessThanOrEqual(MANIFEST_FANOUT)
    const child = children.find(entry => index >= entry.from && index < entry.from + entry.count)
    if (!child) throw new Error('missing child')
    node = JSON.parse(await readFile(contentFile(dir, child.ref.sha256), 'utf8')) as typeof node
    if (node.kind === 'leaf') return child.ref
  }
}
