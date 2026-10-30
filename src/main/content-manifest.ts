import { createHash } from 'node:crypto'
import { isToolContentRef, type ToolContentRef } from '../shared/tool-content'
import { MANIFEST_FANOUT, isManifestRef, type ManifestRef } from '../shared/content-manifest'
import { readRecorderContent, writeRecorderContent } from '../core/turn-recorder/content-store'

/**
 * Content-addressed manifest tree: a bounded-fanout index over an unbounded item list.
 *
 * A flat list of content references cannot be read a page at a time without loading the
 * list, and a chain of references cannot be written forward because each link would have
 * to contain the hash of a link that does not exist yet. A tree solves both: leaves hold
 * a fixed number of entries, branches hold counts and child references, and the writer
 * keeps only one incomplete node per level, so memory is O(fanout · height) instead of
 * O(items). Reading one entry or one range descends by counts: O(height) node reads.
 */
/** One node is serialized and verified whole, so it must stay inside a single content page. */
export const MANIFEST_NODE_BYTES = 256 * 1024

export interface ManifestEntry {
  /** UTF-8 size this entry accounts for; branches carry the sum of their children. */
  bytes: number
  [key: string]: unknown
}

export type { ManifestRef }
export { MANIFEST_FANOUT, isManifestRef }

export interface ManifestNodeRef {
  ref: ToolContentRef
  from: number
  count: number
  bytes: number
}

interface LeafBody {
  v: 1
  kind: 'leaf'
  binding: string
  from: number
  count: number
  bytes: number
  fanout: number
  entries: ManifestEntry[]
}

interface BranchBody {
  v: 1
  kind: 'branch'
  binding: string
  from: number
  count: number
  bytes: number
  fanout: number
  children: ManifestNodeRef[]
}

type NodeBody = LeafBody | BranchBody

/**
 * Ties every node to one frozen source. A leaf copied from another snapshot has a
 * different binding, so substitution fails even though its own hash is valid.
 */
export function manifestBinding(sourceId: string, prefixFingerprint: string): string {
  return createHash('sha256').update(`content-manifest-v1\0${sourceId}\0${prefixFingerprint}`, 'utf8').digest('hex')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Builds one tree, bottom up.
 *
 * `append` publishes a leaf once it is full and folds full levels upward immediately,
 * so the only live state is the current leaf plus at most `fanout` unfinished nodes per
 * level. Nothing is rewritten, so no node ever has to contain a reference to a node
 * that does not exist yet.
 */
export class ManifestWriter {
  private readonly levels: ManifestNodeRef[][] = []
  private pending: ManifestEntry[] = []
  private pendingBytes = 0
  private from = 0
  private count = 0
  private bytes = 0

  constructor(
    private readonly dataRoot: string,
    private readonly binding: string,
    private readonly fanout = MANIFEST_FANOUT
  ) {}

  async append(entry: ManifestEntry): Promise<void> {
    if (!isCount(entry.bytes) || entry.bytes < 0) throw new Error('清单条目字节数无效')
    this.pending.push(entry)
    this.pendingBytes += entry.bytes
    if (this.pending.length >= this.fanout) await this.flush()
  }

  async seal(): Promise<ManifestRef> {
    if (this.pending.length > 0) await this.flush()
    if (this.count === 0) throw new Error('清单为空')
    await this.reduce()
    const roots = this.levels.flat()
    if (roots.length !== 1) throw new Error('清单缺少根节点')
    const [root] = roots
    return { root: root.ref, from: root.from, count: root.count, bytes: root.bytes, fanout: this.fanout }
  }

  private async flush(): Promise<void> {
    const entries = this.pending
    const bytes = this.pendingBytes
    this.pending = []
    this.pendingBytes = 0
    if (entries.length === 0) return
    const leaf = await this.publish({
      v: 1, kind: 'leaf', binding: this.binding, from: this.from,
      count: entries.length, bytes, fanout: this.fanout, entries
    })
    this.from += entries.length
    this.count += entries.length
    this.bytes += bytes
    const level = this.levels[0] ?? []
    level.push(leaf)
    this.levels[0] = level
    await this.collapse(0)
  }

  private async collapse(level: number): Promise<void> {
    const nodes = this.levels[level]
    if (!nodes || nodes.length < this.fanout) return
    const group = nodes.splice(0, this.fanout)
    const branch = await this.branch(group)
    const next = this.levels[level + 1] ?? []
    next.push(branch)
    this.levels[level + 1] = next
    await this.collapse(level + 1)
  }

  private async reduce(): Promise<void> {
    const settled = (level: number): boolean =>
      this.levels.slice(level + 1).every(nodes => nodes.length === 0)
    let level = 0
    for (;;) {
      const nodes = this.levels[level] ?? []
      if (nodes.length === 0) {
        if (settled(level)) return
        level += 1
        continue
      }
      if (nodes.length === 1 && settled(level)) return
      const group = nodes.splice(0, this.fanout)
      const branch = await this.branch(group)
      const next = this.levels[level + 1] ?? []
      next.push(branch)
      this.levels[level + 1] = next
    }
  }

  private async branch(children: ManifestNodeRef[]): Promise<ManifestNodeRef> {
    if (children.length === 0) throw new Error('清单分支没有子节点')
    const bytes = children.reduce((total, child) => total + child.bytes, 0)
    return this.publish({
      v: 1, kind: 'branch', binding: this.binding, from: children[0].from,
      count: children.reduce((total, child) => total + child.count, 0), bytes,
      fanout: this.fanout, children
    })
  }

  private async publish(body: NodeBody): Promise<ManifestNodeRef> {
    const serialized = JSON.stringify(body)
    if (Buffer.byteLength(serialized, 'utf8') > MANIFEST_NODE_BYTES) {
      throw new Error('清单节点超出单页读取预算')
    }
    const ref = await writeRecorderContent(this.dataRoot, serialized, 'json')
    return { ref, from: body.from, count: body.count, bytes: body.bytes }
  }
}

function assertNode(value: unknown, binding: string, expected: { from: number; count: number; bytes: number }): NodeBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('清单节点不是对象')
  const node = value as Record<string, unknown>
  if (node.v !== 1) throw new Error('清单节点版本不受支持')
  if (node.binding !== binding) throw new Error('清单节点不属于当前快照来源')
  if (!isCount(node.from) || !isCount(node.count) || node.count === 0 || !isCount(node.bytes)) {
    throw new Error('清单节点计数无效')
  }
  if (node.from !== expected.from || node.count !== expected.count || node.bytes !== expected.bytes) {
    throw new Error('清单节点与父级计数不一致')
  }
  if (node.fanout !== MANIFEST_FANOUT) throw new Error('清单节点扇出不受支持')
  if (node.kind === 'leaf') {
    if (!Array.isArray(node.entries) || node.entries.length === 0 || node.entries.length > MANIFEST_FANOUT) {
      throw new Error('清单叶子条目数量无效')
    }
    // Lookup descends by the declared count; it must describe the entries actually present.
    if (node.entries.length !== node.count) throw new Error('清单叶子计数与条目数量不一致')
    const entries = node.entries.map(entry => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('清单条目不是对象')
      if (!isCount((entry as ManifestEntry).bytes)) throw new Error('清单条目字节数无效')
      return entry as ManifestEntry
    })
    if (entries.reduce((total, entry) => total + entry.bytes, 0) !== node.bytes) throw new Error('清单叶子字节数与条目不一致')
    return { ...(node as unknown as LeafBody), entries }
  }
  if (node.kind !== 'branch') throw new Error('清单节点类型不受支持')
  if (!Array.isArray(node.children) || node.children.length === 0 || node.children.length > MANIFEST_FANOUT) {
    throw new Error('清单分支子节点数量无效')
  }
  let from = node.from as number
  const children = node.children.map(child => {
    if (child === null || typeof child !== 'object') throw new Error('清单子节点引用无效')
    const raw = child as Record<string, unknown>
    if (!isToolContentRef(raw.ref) || !isCount(raw.from) || !isCount(raw.count) || !isCount(raw.bytes) || raw.count === 0) {
      throw new Error('清单子节点引用无效')
    }
    if (raw.from !== from) throw new Error('清单子节点顺序不连续')
    from += raw.count
    return { ref: raw.ref, from: raw.from, count: raw.count, bytes: raw.bytes }
  })
  if (children.reduce((total, child) => total + child.count, 0) !== node.count) throw new Error('清单分支计数与子节点不一致')
  if (children.reduce((total, child) => total + child.bytes, 0) !== node.bytes) throw new Error('清单分支字节数与子节点不一致')
  return { ...(node as unknown as BranchBody), children }
}

async function readNode(
  dataRoot: string,
  ref: ToolContentRef,
  binding: string,
  expected: { from: number; count: number; bytes: number }
): Promise<NodeBody> {
  if (!isToolContentRef(ref) || ref.encoding !== 'json' || ref.bytes <= 0 || ref.bytes > MANIFEST_NODE_BYTES) {
    throw new Error('清单节点引用无效')
  }
  return assertNode(JSON.parse(await readRecorderContent(dataRoot, ref)) as unknown, binding, expected)
}

export interface ManifestPosition {
  index: number
  entry: ManifestEntry
}

/** One entry by ordinal: descends by counts, never reads the whole index. */
export async function readManifestEntry(
  dataRoot: string,
  manifest: ManifestRef,
  index: number,
  binding: string
): Promise<ManifestEntry> {
  if (!isManifestRef(manifest)) throw new Error('清单根引用无效')
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.count) throw new Error('清单条目位置越界')
  let node = await readNode(dataRoot, manifest.root, binding, manifest)
  for (;;) {
    if (node.kind === 'leaf') {
      const entry = node.entries[index - node.from]
      if (!entry) throw new Error('清单缺少条目')
      return entry
    }
    const child = node.children.find(item => index >= item.from && index < item.from + item.count)
    if (!child) throw new Error('清单缺少子节点')
    node = await readNode(dataRoot, child.ref, binding, child)
  }
}

export interface ManifestByteSlice {
  /** Cumulative byte offset of this entry inside the manifest. */
  start: number
  entry: ManifestEntry
}

/**
 * Entries covering a byte range, addressed by cumulative `bytes`.
 *
 * Branch children carry their byte totals, so a body stored as bounded parts can be
 * paged without reading every earlier part.
 */
export async function readManifestByteRange(
  dataRoot: string,
  manifest: ManifestRef,
  offset: number,
  limit: number,
  binding: string
): Promise<ManifestByteSlice[]> {
  if (!isManifestRef(manifest)) throw new Error('清单根引用无效')
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset < 0 || limit < 0) {
    throw new Error('清单字节范围无效')
  }
  if (offset > manifest.bytes || offset + limit > manifest.bytes) throw new Error('清单字节范围越界')
  const end = offset + limit
  const slices: ManifestByteSlice[] = []
  if (limit === 0) return slices
  const read = async (ref: ToolContentRef, expected: { from: number; count: number; bytes: number }, base: number): Promise<void> => {
    const node = await readNode(dataRoot, ref, binding, expected)
    let cursor = base
    if (node.kind === 'leaf') {
      for (const entry of node.entries) {
        const start = cursor
        cursor += entry.bytes
        if (cursor <= offset || start >= end) continue
        slices.push({ start, entry })
      }
      return
    }
    for (const child of node.children) {
      const childEnd = cursor + child.bytes
      if (childEnd <= offset || cursor >= end) { cursor = childEnd; continue }
      await read(child.ref, child, cursor)
      cursor = childEnd
    }
  }
  await read(manifest.root, manifest, 0)
  if (slices.length === 0) throw new Error('清单字节范围没有条目')
  return slices
}

/**
 * A contiguous range in order. Only leaves that overlap the range are read, so paging a
 * viewer never loads the whole index.
 */
export async function readManifestRange(
  dataRoot: string,
  manifest: ManifestRef,
  from: number,
  count: number,
  binding: string
): Promise<ManifestEntry[]> {
  if (!isManifestRef(manifest)) throw new Error('清单根引用无效')
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(count) || from < 0 || count < 0) throw new Error('清单范围无效')
  if (from + count > manifest.count) throw new Error('清单范围越界')
  const entries: ManifestEntry[] = []
  if (count === 0) return entries
  const end = from + count
  const read = async (ref: ToolContentRef, expected: { from: number; count: number; bytes: number }): Promise<void> => {
    const node = await readNode(dataRoot, ref, binding, expected)
    if (node.kind === 'leaf') {
      for (let index = node.from; index < node.from + node.count; index += 1) {
        if (index < from || index >= end) continue
        entries.push(node.entries[index - node.from])
      }
      return
    }
    for (const child of node.children) {
      if (child.from + child.count <= from || child.from >= end) continue
      await read(child.ref, child)
    }
  }
  await read(manifest.root, manifest)
  if (entries.length !== count) throw new Error('清单范围读取不完整')
  return entries
}
