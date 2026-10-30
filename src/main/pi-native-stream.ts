import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { TextSpool, type SpoolBudget } from './text-spool'
import { projectPiRecords, type PiJsonlEvent } from './pi-jsonl-projector'
import { nativeBranch, validateHeader, type NativeEntry } from './pi-native-parse'
import { historyCopy } from '../shared/constants/copy'
import { allSpools, captureSpools, settleAndRelease, type TurnBodies } from './conversation-side-chat-streamed'
import type { StreamedTurn } from './conversation-side-chat-stream'

/**
 * Streaming projection of a Pi session file for side chats.
 *
 * Pi hangs every record off a `parentId`, and only the ancestry of the file's last record is
 * the live conversation: a branch the user abandoned must never reach the snapshot. The file
 * is read twice. The first pass reads structure only, proves the identity header
 * (`type: 'session'`, `version: 3`, `id`, `cwd`) and selects the active leaf's ancestry. The
 * second pass reads the same byte range again and keeps visible text of the records on that
 * branch; every other record, every tool payload, every image and every reasoning block is
 * dropped while it is still tokens, so a 20 MiB tool result never becomes a JSON value.
 *
 * Two passes mean one extra file read, not two snapshots: both passes hash the exact byte
 * span the first one measured and the digests must match, so a same-size rewrite between the
 * passes cannot mix the branch the first pass selected with bodies the second pass read. An
 * append during the read only adds bytes the frozen prefix never claimed, so it stays legal.
 * A trailing unfinished record is dropped, exactly as in the Claude reader, because a record
 * that never ended is not evidence.
 *
 * Resident bodies are bounded by the shared spool budget, not by the length of the history:
 * a turn that closes is settled and its spools released as soon as the caller has consumed
 * it, so a long session cannot keep every earlier body in memory while the file is read.
 *
 * The two passes are the file read cost of this reader; the byte digests add hashing work,
 * not a third read.
 */

export interface PiNativeStreamOptions {
  path: string
  /** Identity the header must claim itself. */
  sessionId: string
  cwd: string
  /** Whether a terminal marker proves Pi finished the turn. */
  settles: (stopReason: string | undefined) => boolean
}

interface PiEntryMeta {
  id: string
  parentId?: string | null
}

/** Text of one record, kept in memory while it is small and spooled once it is not. */
class Body {
  private buffer = ''
  private spool?: TextSpool

  constructor(private readonly create: () => TextSpool) {}

  async push(text: string): Promise<void> {
    // The tokenizer emits multibyte text in very small pieces, so the batch is what keeps a
    // large body from becoming one spool write per piece.
    this.buffer += text
    if (this.buffer.length < TEXT_BATCH_CHARS) return
    this.spool ??= this.create()
    await this.spool.push(this.buffer)
    this.buffer = ''
  }

  /** Hands the text to the turn as a spool; nothing is written for an empty body. */
  async seal(): Promise<TextSpool | undefined> {
    if (!this.spool && this.buffer.length === 0) return undefined
    const spool = this.spool ?? this.create()
    if (this.buffer.length > 0) await spool.push(this.buffer)
    this.buffer = ''
    this.spool = undefined
    return spool
  }

  async discard(): Promise<void> {
    this.buffer = ''
    if (!this.spool) return
    const spool = this.spool
    this.spool = undefined
    await spool.discard()
  }
}

const TEXT_BATCH_CHARS = 64 * 1024

/** First pass: identity, entry topology and the active leaf, without any body. */
class TopologyScan {
  readonly entries = new Map<string, PiEntryMeta>()
  leaf: PiEntryMeta | undefined
  private readonly scalars = new Map<string, string | number | boolean | null>()
  private records = 0

  constructor(private readonly identity: { sessionId: string; cwd: string }) {}

  accept(event: PiJsonlEvent): void {
    if (event.t === 'beginRecord') { this.scalars.clear(); return }
    if (event.t === 'scalar') {
      const value = event.kind === 'number' ? Number(event.raw)
        : event.kind === 'boolean' ? event.raw === 'true'
          : event.kind === 'null' ? null : event.raw
      this.scalars.set(event.slot, value)
      return
    }
    if (event.t !== 'endRecord') return
    if (this.records === 0) {
      this.records = 1
      // The header is exactly these four fields; anything else in it is not identity.
      validateHeader({
        type: this.scalars.get('root.type'),
        version: this.scalars.get('root.version'),
        id: this.scalars.get('root.id'),
        cwd: this.scalars.get('root.cwd')
      } as unknown as NativeEntry, this.identity)
      return
    }
    this.records += 1
    const id = this.scalars.get('root.id')
    if (typeof id !== 'string' || this.entries.has(id)) throw new Error(historyCopy.nativeEntryInvalid)
    const parentId = this.scalars.get('root.parentId')
    const entry: PiEntryMeta = { id, ...(parentId === undefined ? {} : { parentId: parentId as string | null }) }
    this.entries.set(id, entry)
    // The file's last record is the active leaf; earlier leaves are abandoned branches.
    this.leaf = entry
  }
}

/** Second pass: visible bodies of the records on the selected branch. */
class BranchBodies {
  private readonly scalars = new Map<string, string | number | boolean | null>()
  private blocks: TextSpool[] = []
  private block?: { type?: string; body: Body }
  private messageBody: Body | undefined

  constructor(
    private readonly branch: ReadonlySet<string>,
    private readonly state: { current: TurnBodies | undefined; sawUnsettled: boolean },
    private readonly ready: TurnBodies[],
    private readonly createSpool: () => TextSpool,
    private readonly release: (spools: Iterable<TextSpool>) => Promise<void>
  ) {}

  async accept(event: PiJsonlEvent): Promise<void> {
    switch (event.t) {
      case 'beginRecord':
        this.scalars.clear()
        this.blocks = []
        this.block = undefined
        this.messageBody = undefined
        return
      case 'scalar':
        // A block's `type` decides whether its already-read text is visible at all.
        if (event.slot === 'block.type' && event.kind === 'string') {
          this.block ??= { body: new Body(this.createSpool) }
          this.block.type = event.raw
        }
        if (event.slot === 'message.role' || event.slot === 'root.id' || event.slot === 'root.type' ||
            event.slot === 'root.timestamp' || event.slot === 'message.stopReason') {
          this.scalars.set(event.slot, event.raw)
        }
        return
      case 'beginBlock':
        this.block = { body: new Body(this.createSpool) }
        return
      case 'text':
        await this.text(event.text)
        return
      case 'endBlock': {
        const block = this.block
        this.block = undefined
        if (!block) return
        const kept = block.type === 'text' ? await block.body.seal() : undefined
        if (kept) this.blocks.push(kept)
        else await block.body.discard()
        return
      }
      case 'endRecord':
        await this.endRecord()
    }
  }

  private get role(): string | undefined {
    const role = this.scalars.get('message.role')
    return typeof role === 'string' ? role : undefined
  }

  /** Tool output and reasoning are never part of a snapshot body. */
  private async text(chunk: string): Promise<void> {
    if (this.role === 'toolResult') return
    if (this.block) {
      await this.block.body.push(chunk)
      return
    }
    this.messageBody ??= new Body(this.createSpool)
    await this.messageBody.push(chunk)
  }

  private async endRecord(): Promise<void> {
    const id = this.scalars.get('root.id')
    const role = this.role
    const inBranch = typeof id === 'string' && this.branch.has(id)
    if (!inBranch || role === undefined || this.scalars.get('root.type') !== 'message') {
      await this.drop()
      return
    }
    const string = await this.messageBody?.seal()
    if (role === 'user') {
      // Pi joins a user message's text blocks with a newline; the prompt keeps that text
      // exactly, and the blocks it came from are released once it is written out.
      const blocks = this.blocks
      this.blocks = []
      this.messageBody = undefined
      const prompt = string ?? await this.joinText(blocks)
      this.close()
      this.state.current = { runId: `pi-native-${id}`, prompt, assistant: [] }
      return
    }
    // Pi's own reader refuses a message whose timestamp cannot place it.
    const timestamp = this.scalars.get('root.timestamp')
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error('Pi 原生消息时间无效')
    }
    const current = this.state.current
    if (role === 'assistant' && current) {
      if (this.blocks.length > 0) current.assistant.push({ spools: this.blocks })
      if (string) current.assistant.push({ spools: [string] })
      const stopReason = this.scalars.get('message.stopReason')
      // Only the turn's last assistant message speaks for it.
      current.stopReason = typeof stopReason === 'string' && stopReason.trim() ? stopReason.trim() : undefined
      this.blocks = []
      this.messageBody = undefined
      return
    }
    if (string) await this.release([string])
    await this.drop()
  }

  private async joinText(blocks: readonly TextSpool[]): Promise<TextSpool> {
    if (blocks.length === 1) return blocks[0]
    const joined = this.createSpool()
    let first = true
    for (const block of blocks) {
      if (!first) await joined.push('\n')
      first = false
      for await (const chunk of block.read()) await joined.push(chunk)
    }
    await this.release(blocks)
    return joined
  }

  /** A trailing turn with no following prompt still ends at EOF. */
  async finish(): Promise<void> {
    await this.drop()
    this.close()
  }

  private close(): void {
    if (this.state.current) this.ready.push(this.state.current)
    this.state.current = undefined
    this.blocks = []
    this.messageBody = undefined
    this.block = undefined
  }

  private async drop(): Promise<void> {
    await this.release(this.blocks)
    this.blocks = []
    if (this.messageBody) await this.messageBody.discard()
    this.messageBody = undefined
    if (this.block) await this.block.body.discard()
    this.block = undefined
  }
}

export async function* streamPiNativeTurns(
  options: PiNativeStreamOptions,
  budget: SpoolBudget = { available: 4 * 1024 * 1024 }
): AsyncGenerator<StreamedTurn> {
  const handle = await open(options.path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return
  const spools = captureSpools(budget)
  const { create: createSpool, release } = spools
  const ready: TurnBodies[] = []
  const state = { current: undefined as TurnBodies | undefined, sawUnsettled: false }
  const settled = (turn: TurnBodies): AsyncGenerator<StreamedTurn> =>
    settleAndRelease(turn, options, state, release)
  const settleRelease = (turn: TurnBodies): Promise<void> => release(allSpools(turn))
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Pi 原生会话文件不是普通文件')
    const topology = new TopologyScan({ sessionId: options.sessionId, cwd: options.cwd })
    const structural = { bytes: 0, digest: createHash('sha256') }
    for await (const event of projectPiRecords(handle, before.size, structural, 'metadata')) topology.accept(event)
    const branchIds = new Set(nativeBranch(topology.entries, topology.leaf).map(entry => entry.id))
    const bodies = new BranchBodies(branchIds, state, ready, createSpool, release)
    const evidence = { bytes: 0, digest: createHash('sha256') }
    for await (const event of projectPiRecords(handle, before.size, evidence, 'body')) {
      await bodies.accept(event)
      // A turn that just closed is settled before the next record is read.
      while (ready.length > 0) yield* settled(ready.shift()!)
    }
    await bodies.finish()
    while (ready.length > 0) yield* settled(ready.shift()!)
    // Both passes must have read the same bytes: a same-size rewrite leaves inode, device
    // and size untouched, so only the content can prove the branch and the bodies agree.
    if (structural.digest.digest('hex') !== evidence.digest.digest('hex') ||
        structural.bytes !== evidence.bytes) {
      throw new Error('Pi 原生会话文件在读取期间被改写，不能确认快照来源')
    }
    const after = await handle.stat()
    if (after.ino !== before.ino || after.dev !== before.dev || after.size < evidence.bytes) {
      throw new Error('Pi 原生会话文件在读取期间被替换或截断，不能确认快照来源')
    }
  } finally {
    for (const closed of ready.splice(0)) await settleRelease(closed)
    if (state.current) await settleRelease(state.current)
    await spools.releaseAll()
    await handle.close()
  }
}
