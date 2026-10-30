import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { TextSpool } from './text-spool'
import { JsonlRecordScanner, type JsonlEvent, type ScalarSlot } from './jsonl-record-scanner'
import type { StreamedMessage, StreamedTurn } from './conversation-side-chat-stream'
import type { CaptureItem, CaptureSink } from './conversation-side-chat-capture'
import { TitleTap, consume, type RequestedBoundary } from './conversation-side-chat-sink'
import type { ProviderId } from '../shared/provider'

/**
 * Streaming native JSONL projection for side chats.
 *
 * Records are read through the incremental scanner, so a single 195 MiB tool result never
 * becomes a JSON value, and visible text is spooled instead of accumulated: a frozen
 * prefix costs the sealed manifest, not memory.
 *
 * The projection keeps the boundaries the shared native normalizer proves. A record whose
 * `message.content` is a `text` block opens a turn; `isMeta` and `isCompactSummary`
 * records never become a human prompt; a task notification is a continuation; an injected
 * skill directive continues the current turn; and only the Provider's own terminal marker
 * settles a turn. Visible text never settles anything.
 *
 * Only the captured prefix is authoritative. A file that shrank below the bytes this read
 * consumed, or that was replaced while it was read, proves nothing about that prefix and
 * is refused; a longer file is a later append and cannot change what was already read. An
 * unfinished trailing record is dropped rather than parsed, so a live append between
 * reads does not block freezing the completed prefix.
 */

const READ_CHUNK_BYTES = 1024 * 1024
/** The normalizer recognises a skill directive from this marker; only its head matters. */
const SKILL_MARKER = 'Base directory for this skill:'
/** Enough of a prompt to recognise a task notification or a skill directive. */
const PROMPT_HEAD_CHARS = 4096
const TASK_NOTIFICATION = '<task-notification>'

/** One assistant record's visible blocks: blocks join with nothing, records by a blank line. */
interface AssistantPart {
  spools: TextSpool[]
}

interface TurnState {
  prompt: TextSpool
  providerTurnId?: string
  assistant: AssistantPart[]
  stopReason?: string
}

export interface NativeTranscriptStreamOptions {
  path: string
  /** Session-scoped identity: a raw transcript carries no Scry run id. */
  runId: string
  /** Identity the transcript must claim itself: its own records name session and cwd. */
  sessionId: string
  cwd?: string
  /** Whether a terminal marker proves the Provider finished the turn. */
  settles: (stopReason: string | undefined) => boolean
}

/** Assistant body as ordered chunks: records joined by a blank line, blocks by none. */
async function* assistantText(parts: readonly AssistantPart[]): AsyncGenerator<string> {
  let first = true
  for (const part of parts) {
    if (!first) yield '\n\n'
    first = false
    for (const spool of part.spools) {
      for await (const chunk of spool.read()) yield chunk
    }
  }
}

async function assistantMessage(parts: readonly AssistantPart[]): Promise<StreamedMessage> {
  const hash = createHash('sha256')
  let bytes = 0
  let first = true
  for (const part of parts) {
    if (!first) {
      hash.update('\n\n', 'utf8')
      bytes += 2
    }
    first = false
    for (const spool of part.spools) {
      // Flushed before the size is read, so a held surrogate is part of the message.
      await spool.flush()
      bytes += spool.size
      for await (const chunk of spool.read()) hash.update(chunk, 'utf8')
    }
  }
  return { role: 'assistant', bytes, contentHash: hash.digest('hex'), text: assistantText(parts) }
}

async function promptMessage(spool: TextSpool): Promise<StreamedMessage> {
  await spool.flush()
  const bytes = spool.size
  const contentHash = await spool.digest()
  return { role: 'user', bytes, contentHash, text: spool.read() }
}

function allSpools(turn: TurnState): TextSpool[] {
  return [turn.prompt, ...turn.assistant.flatMap(part => part.spools)]
}

/**
 * Projects one native transcript into settled turns, in order.
 *
 * The generator owns every spool it creates: it frees them once a message body has been
 * consumed and on error, so an aborted capture leaves no temporary file behind.
 */
export async function* streamNativeTranscriptTurns(
  options: NativeTranscriptStreamOptions
): AsyncGenerator<StreamedTurn> {
  const handle = await open(options.path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return
  const live = new Set<TextSpool>()
  const createSpool = (): TextSpool => {
    const created = new TextSpool()
    live.add(created)
    return created
  }
  const release = async (spools: Iterable<TextSpool>): Promise<void> => {
    for (const spool of spools) {
      live.delete(spool)
      await spool.discard()
    }
  }
  const ready: TurnState[] = []
  const state = { suppress: false, sawUnsettled: false, current: undefined as TurnState | undefined }
  const record = new RecordProjection(state, createSpool, ready, {
    sessionId: options.sessionId, ...(options.cwd === undefined ? {} : { cwd: options.cwd })
  })
  const pump = async (events: readonly JsonlEvent[]): Promise<void> => {
    for (const event of events) await record.accept(event)
  }
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('原生会话 transcript 不是普通文件')
    const scanner = new JsonlRecordScanner()
    const decoder = new TextDecoder('utf-8')
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let read = 0
    for (;;) {
      const chunk = await handle.read(buffer, 0, buffer.length, read)
      if (chunk.bytesRead === 0) break
      read += chunk.bytesRead
      scanner.feed(decoder.decode(buffer.subarray(0, chunk.bytesRead), { stream: true }))
      await pump(scanner.drain())
      for (const closed of ready.splice(0)) yield* settle(closed, options, state, release)
    }
    const tail = decoder.decode()
    if (tail.length > 0) scanner.feed(tail)
    // An unfinished trailing record is not evidence; only newline-complete records are.
    scanner.end()
    await pump(scanner.drain())
    // The last turn ends at EOF, not at a following prompt record.
    if (state.current) {
      ready.push(state.current)
      state.current = undefined
    }
    for (const closed of ready.splice(0)) yield* settle(closed, options, state, release)
    const after = await handle.stat()
    if (after.ino !== before.ino || after.dev !== before.dev || after.size < read) {
      throw new Error('原生会话 transcript 在读取期间被替换或截断，不能确认快照来源')
    }
  } finally {
    for (const closed of ready.splice(0)) await release(allSpools(closed))
    if (state.current) await release(allSpools(state.current))
    await release(live)
    await handle.close()
  }
}

/** Applies the prefix rule: a settled turn is frozen, an interior unsettled one refuses. */
async function* settle(
  turn: TurnState,
  options: NativeTranscriptStreamOptions,
  state: { sawUnsettled: boolean },
  release: (spools: Iterable<TextSpool>) => Promise<void>
): AsyncGenerator<StreamedTurn> {
  if (!options.settles(turn.stopReason)) {
    state.sawUnsettled = true
    await release(allSpools(turn))
    return
  }
  if (state.sawUnsettled) {
    await release(allSpools(turn))
    throw new Error('原生会话前缀包含没有终止证据的轮次，不能创建侧聊')
  }
  const messages: StreamedMessage[] = [await promptMessage(turn.prompt)]
  if (turn.assistant.length > 0) messages.push(await assistantMessage(turn.assistant))
  yield {
    runId: options.runId, status: 'unavailable', settled: true, messages,
    ...(turn.providerTurnId === undefined ? {} : { providerTurnId: turn.providerTurnId })
  }
}

/** Accumulates one JSONL record and applies the native turn rules when it ends. */
class RecordProjection {
  private readonly scalars = new Map<ScalarSlot, string | boolean>()
  private blocks: TextSpool[] = []
  private block?: { type?: string; spool?: TextSpool }
  private prompt?: TextSpool
  private head = ''
  private records = 0

  constructor(
    private readonly state: { suppress: boolean; current: TurnState | undefined },
    private readonly createSpool: () => TextSpool,
    private readonly closed: TurnState[],
    private readonly identity: { sessionId: string; cwd?: string }
  ) {}

  async accept(event: JsonlEvent): Promise<void> {
    switch (event.t) {
      case 'beginRecord':
        this.scalars.clear()
        this.blocks = []
        this.block = undefined
        this.prompt = undefined
        this.head = ''
        return
      case 'scalar':
        if (event.kind === 'boolean') this.scalars.set(event.slot, event.raw === 'true')
        else if (event.kind === 'string') this.scalars.set(event.slot, event.raw)
        // A block's `type` decides whether its already-streamed text is visible at all.
        if (event.slot === 'block.type' && event.kind === 'string') {
          this.block ??= {}
          this.block.type = event.raw
        }
        return
      case 'promptText':
        this.prompt ??= this.createSpool()
        await this.prompt.push(event.text)
        this.takeHead(event.text)
        return
      case 'blockText':
        this.block ??= {}
        this.block.spool ??= this.createSpool()
        await this.block.spool.push(event.text)
        this.takeHead(event.text)
        return
      case 'beginBlock':
        this.block = {}
        return
      case 'blockEnd': {
        const block = this.block
        this.block = undefined
        if (!block) return
        if (block.type === 'text' && block.spool) this.blocks.push(block.spool)
        else if (block.spool) await block.spool.discard()
        return
      }
      case 'endRecord':
        await this.endRecord()
    }
  }

  private async endRecord(): Promise<void> {
    this.records += 1
    // The transcript identifies itself in its own head, so a same-named file from another
    // session or workspace is refused without re-reading or re-parsing the whole file.
    if (this.records === 1) this.assertIdentity()
    const type = this.string('root.type')
    if (type === 'user') await this.userRecord()
    else if (type === 'assistant') await this.assistantRecord()
    else await this.discardRecord()
  }

  private async userRecord(): Promise<void> {
    const prompt = this.prompt ?? this.blocks[0]
    if (this.scalars.get('root.isCompactSummary') === true) return this.discardRecord()
    const head = this.head.trimStart()
    if (this.scalars.get('origin.kind') === 'task-notification' || head.startsWith(TASK_NOTIFICATION)) {
      this.state.suppress = false
      return this.discardRecord()
    }
    const skill = this.head.includes(SKILL_MARKER)
    if (this.scalars.get('root.isMeta') === true && !skill) {
      this.close()
      this.state.suppress = true
      return this.discardRecord()
    }
    // An injected-skill directive and a text-less record both continue the current turn.
    if (skill || !prompt) return this.discardRecord()
    this.close()
    this.state.suppress = false
    const providerTurnId = this.turnId()
    this.state.current = {
      prompt, assistant: [], ...(providerTurnId === undefined ? {} : { providerTurnId })
    }
    this.prompt = undefined
    this.blocks = []
  }

  private async assistantRecord(): Promise<void> {
    const current = this.state.current
    if (!current || this.state.suppress) return this.discardRecord()
    if (this.blocks.length > 0) current.assistant.push({ spools: this.blocks })
    const stopReason = this.string('message.stopReason')
    if (stopReason !== undefined) current.stopReason = stopReason
    this.blocks = []
  }

  /** A dropped record never keeps its spools: nothing it held belongs to the prefix. */
  private async discardRecord(): Promise<void> {
    const spools = [...(this.prompt ? [this.prompt] : []), ...this.blocks,
      ...(this.block?.spool ? [this.block.spool] : [])]
    this.prompt = undefined
    this.blocks = []
    this.block = undefined
    for (const spool of spools) await spool.discard()
  }

  private assertIdentity(): void {
    const sessionId = this.string('root.sessionId')
    if (sessionId !== undefined && sessionId !== this.identity.sessionId) {
      throw new Error('原生会话 transcript 属于其他会话，不能确认快照来源')
    }
    const cwd = this.string('root.cwd')
    if (cwd !== undefined && this.identity.cwd !== undefined && cwd !== this.identity.cwd) {
      throw new Error('原生会话 transcript 属于其他工作区，不能确认快照来源')
    }
  }

  private close(): void {
    const current = this.state.current
    if (!current) return
    this.state.current = undefined
    this.closed.push(current)
  }

  private string(slot: ScalarSlot): string | undefined {
    const value = this.scalars.get(slot)
    return typeof value === 'string' ? value : undefined
  }

  private turnId(): string | undefined {
    for (const slot of ['root.promptId', 'root.prompt_id', 'root.turnId', 'root.turn_id'] as const) {
      const value = this.string(slot)
      if (value) return value
    }
    return undefined
  }

  private takeHead(chunk: string): void {
    if (this.head.length >= PROMPT_HEAD_CHARS) return
    this.head += chunk.slice(0, PROMPT_HEAD_CHARS - this.head.length)
  }
}

/**
 * Feeds a Provider transcript projected record by record straight into the sink.
 *
 * A spooled body means a long transcript costs the sealed manifest, not memory, and an
 * unfinished trailing record or a later append cannot change the frozen prefix. The
 * reader has already refused a prefix with an unsettled turn before a settled one, so
 * only the requested boundary and the title remain to be decided here.
 */
export async function captureStreamedNativePrefix(args: {
  source: { providerId: ProviderId; nativeSessionId: string }
  stream: AsyncGenerator<StreamedTurn>
  boundary: RequestedBoundary | undefined
  sink: CaptureSink
}): Promise<{ items: CaptureItem[]; title?: string; through?: { ordinal: number; runId: string } }> {
  const { source, stream, boundary, sink } = args
  const items: CaptureItem[] = []
  const title = new TitleTap()
  let through: { ordinal: number; runId: string } | undefined
  let ordinal = 0
  for await (const turn of stream) {
    ordinal += 1
    if (boundary !== undefined && ordinal > boundary.ordinal) break
    if (boundary?.runId !== undefined && ordinal === boundary.ordinal && turn.runId !== boundary.runId) {
      throw new Error('原生会话快照边界已变化，请重新预览；本次未创建侧聊')
    }
    for (const message of turn.messages) {
      items.push(await consume(sink, message, {
        role: message.role, sourceRunId: turn.runId, sourceOrdinal: ordinal,
        providerId: source.providerId, status: turn.status, delivery: 'snapshot',
        nativeSessionId: source.nativeSessionId,
        ...(turn.providerTurnId === undefined ? {} : { providerTurnId: turn.providerTurnId })
      }, title))
    }
    through = { ordinal, runId: turn.runId }
    if (boundary !== undefined && ordinal === boundary.ordinal) break
  }
  if (boundary !== undefined && through?.ordinal !== boundary.ordinal) {
    throw new Error('原生会话快照边界已消失，请重新预览；本次未创建侧聊')
  }
  return { items, ...(title.value === undefined ? {} : { title: title.value }), ...(through === undefined ? {} : { through }) }
}
