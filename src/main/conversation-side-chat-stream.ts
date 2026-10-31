import { createHash } from 'node:crypto'
import { APP_TRACE_CONTENT_SOURCE, readAppTraceContentPage } from './trace-tool-content'
import { TextSpool, type SpoolBudget } from './text-spool'
import { Utf8ChunkNormalizer } from './utf8-chunks'
import type { ArchiveBodyFacts, ArchiveEntry } from './trace-archive-projection'

/**
 * Turns a projected archive stream into ordered visible messages, with bounded memory.
 *
 * One message may be hundreds of MiB. Nothing here joins text: every body stays a spool
 * (resident bytes bounded by a shared allowance, then a private temporary file) or a
 * paged content reference, and is streamed out exactly once when the caller writes it.
 *
 * The message order is the one the recorder already uses: the turn's prompt, then the
 * visible assistant text up to each accepted steer, then that steer's prompt, then the
 * remaining text. A body is only a message when some recorded text proves it; reasoning,
 * tool protocol and subagent text are never projected.
 */
export interface StreamedMessage {
  role: 'user' | 'assistant'
  steerMessageId?: string
  /** Exact text as bounded chunks; never a joined string. */
  text: AsyncIterable<string>
  contentHash: string
  bytes: number
}

export interface StreamedTurn {
  runId: string
  providerTurnId?: string
  status: string
  settled: boolean
  messages: StreamedMessage[]
}

/** A stored visible body: exact byte size, streamed content, lazy digest. */
interface Body {
  bytes: number
  read(): AsyncGenerator<string>
  digest(): Promise<string>
}

type Part =
  | { kind: 'user'; spool: TextSpool }
  | { kind: 'steer'; status: string; messageId?: string; spool: TextSpool; event: number }
  | { kind: 'event'; event: number; stage: string; messageId?: string; codexItemId?: string; replaces: boolean; spool: TextSpool; body?: ArchiveBodyFacts }
  | { kind: 'break' }

function spoolBody(spool: TextSpool): Body {
  let digest: Promise<string> | undefined
  return {
    bytes: spool.size,
    read: () => spool.read(),
    digest: () => digest ??= spool.digest()
  }
}

/**
 * A visible body stored by content reference is streamed page by page.
 *
 * Provenance is checked before a single byte is trusted: only a complete, unredacted
 * utf8 body in Scry's own archive store may stand in for recorded text. Preview text,
 * a foreign store or a failed redaction is an incomplete source, not a smaller body.
 */
function refBody(userData: string, cwd: string, facts: ArchiveBodyFacts): Body {
  const ref = facts.contentRef
  if (!ref || facts.source !== APP_TRACE_CONTENT_SOURCE || facts.encoding !== 'utf8' ||
    facts.sourceCompleteness !== 'complete' || facts.redaction === 'failed' || ref.encoding !== 'utf8' ||
    ref.storage !== 'recorder-content-v1' || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) < 0) {
    throw new Error('来源归档正文缺少可验证的完整引用，不能冻结为侧聊历史')
  }
  const contentRef = { storage: 'recorder-content-v1' as const, sha256: ref.sha256, bytes: ref.bytes as number, encoding: 'utf8' as const }
  let digest: Promise<string> | undefined
  const read = async function* (): AsyncGenerator<string> {
    const hash = createHash('sha256')
    // One decoder for the whole body: a page boundary may fall inside a character.
    const decoder = new TextDecoder('utf-8')
    let offset = 0
    for (;;) {
      const page = await readAppTraceContentPage(userData, cwd, { source: 'app-trace', ref: contentRef, offset })
      const chunk = Buffer.from(page.dataBase64, 'base64')
      hash.update(chunk)
      offset = page.nextOffset
      const text = decoder.decode(chunk, { stream: true })
      if (text.length > 0) yield text
      if (!page.hasMore || offset >= contentRef.bytes) break
    }
    const tail = decoder.decode()
    if (tail.length > 0) yield tail
    if (offset !== contentRef.bytes) throw new Error('来源归档正文引用长度与内容不一致')
    const actual = hash.digest('hex')
    if (actual !== contentRef.sha256) throw new Error('来源归档正文引用内容已被改写')
  }
  return {
    bytes: contentRef.bytes,
    read,
    digest: () => digest ??= (async () => {
      for await (const _chunk of read()) { /* verified while streaming */ }
      return contentRef.sha256
    })()
  }
}

function eventBody(userData: string, cwd: string, part: Extract<Part, { kind: 'event' }>): Body {
  if (part.body?.contentRef) return refBody(userData, cwd, part.body)
  if (part.body) {
    // Inline envelopes must still prove completeness; `truncated`/`omitted` is not text.
    const facts = part.body
    if (facts.sourceCompleteness !== undefined && facts.sourceCompleteness !== 'complete') {
      throw new Error('来源归档正文不完整，不能用预览代替全文')
    }
    if (facts.redaction === 'failed') throw new Error('来源归档正文脱敏失败，不能冻结为侧聊历史')
    if (facts.storage !== undefined && facts.storage !== 'complete') {
      throw new Error('来源归档只有预览，缺少完整正文引用')
    }
  }
  return spoolBody(part.spool)
}

/** Concat of several bodies, in order, without joining any of them. */
function joinBodies(bodies: readonly Body[]): Body {
  return {
    bytes: bodies.reduce((sum, body) => sum + body.bytes, 0),
    read: async function* () {
      for (const body of bodies) yield* body.read()
    },
    digest: async () => {
      const hash = createHash('sha256')
      for (const body of bodies) for await (const chunk of body.read()) hash.update(chunk, 'utf8')
      return hash.digest('hex')
    }
  }
}

/**
 * One assistant text group, with the recorder's own delta rules.
 *
 * A final body that merely repeats the streamed deltas is dropped, a `replacesStreamedText`
 * body supersedes its group, and groups are joined by a blank line. The comparison is by
 * exact byte size first, so a large body is hashed only when its size actually matches.
 */
async function groupBody(userData: string, cwd: string, events: ReadonlyArray<Extract<Part, { kind: 'event' }>>): Promise<Body | undefined> {
  const bodies = events.map(part => eventBody(userData, cwd, part))
  if (bodies.every(body => body.bytes === 0)) return undefined
  const authoritative = events.findLastIndex(part => part.stage === 'text' && part.replaces)
  if (authoritative >= 0) return bodies[authoritative]
  const deltas = events.flatMap((part, index) => part.stage === 'text_delta' ? [bodies[index]] : [])
  const finals = events.flatMap((part, index) => part.stage === 'text' ? [bodies[index]] : [])
  if (finals.length === 0 || deltas.length === 0) return joinBodies(events.map((_part, index) => bodies[index]))
  const deltaBytes = deltas.reduce((sum, body) => sum + body.bytes, 0)
  const candidates = events.flatMap((part, index) => part.stage === 'text' && bodies[index].bytes === deltaBytes ? [index] : [])
  const repeated = new Set<number>()
  if (candidates.length > 0) {
    const streamed = await joinBodies(deltas).digest()
    for (const index of candidates) {
      if (await bodies[index].digest() === streamed) repeated.add(index)
    }
  }
  const kept = bodies.filter((_body, index) => !repeated.has(index))
  return kept.length === 0 ? undefined : joinBodies(kept)
}

/** Visible text of one assistant slice: groups in order, separated by a blank line. */
async function sliceBody(userData: string, cwd: string, parts: readonly Part[]): Promise<Body | undefined> {
  const groups: Array<Array<Extract<Part, { kind: 'event' }>>> = []
  let current: Array<Extract<Part, { kind: 'event' }>> = []
  for (const part of parts) {
    if (part.kind === 'break') {
      if (current.length > 0) groups.push(current)
      current = []
      continue
    }
    if (part.kind !== 'event') continue
    const first = current[0]
    if (first && (first.messageId !== part.messageId || first.codexItemId !== part.codexItemId)) {
      groups.push(current)
      current = []
    }
    current.push(part)
  }
  if (current.length > 0) groups.push(current)
  const bodies: Body[] = []
  for (const group of groups) {
    const body = await groupBody(userData, cwd, group)
    if (body) bodies.push(body)
  }
  if (bodies.length === 0) return undefined
  const separated: Body[] = []
  bodies.forEach((body, index) => {
    if (index > 0) separated.push(joinBodies([{ bytes: 2, read: async function* () { yield '\n\n' }, digest: async () => '' }]))
    separated.push(body)
  })
  return joinBodies(separated)
}

/**
 * Input spools of the turn being built, without duplicates.
 *
 * A prompt's spool is pushed into the parts as well, and the turn's events each own one, so
 * the same object can appear twice. These are created for reading the archive, not by the
 * registry that tracks sealed bodies: nothing else frees them, and a reference dropped by
 * `reset` takes its budget charge and its spill file with it.
 */
function inputSpools(parts: readonly Part[], userSpool: TextSpool | undefined): TextSpool[] {
  const spools = new Set<TextSpool>()
  if (userSpool) spools.add(userSpool)
  for (const part of parts) if (part.kind !== 'break') spools.add(part.spool)
  return [...spools]
}

async function discardSpools(spools: Iterable<TextSpool>): Promise<void> {
  for (const spool of spools) await spool.discard()
}

/** Every spool this pass created, so an aborted capture leaves no temporary files. */
class SpoolRegistry {
  private live = new Set<TextSpool>()
  constructor(private readonly budget: SpoolBudget) {}

  create(): TextSpool {
    const spool = new TextSpool(256 * 1024, this.budget)
    this.live.add(spool)
    return spool
  }

  release(spool: TextSpool): void {
    this.live.delete(spool)
  }

  async discardAll(): Promise<void> {
    const live = [...this.live]
    this.live.clear()
    for (const spool of live) await spool.discard()
  }
}

/** Materializes a body into one spool so its exact size and hash are known before use. */
async function sealBody(body: Body, registry: SpoolRegistry): Promise<{ spool: TextSpool; bytes: number; contentHash: string }> {
  const spool = registry.create()
  const hash = createHash('sha256')
  // Hash, count and store whole code points: a body reader may split a surrogate pair.
  const normalizer = new Utf8ChunkNormalizer()
  let bytes = 0
  const take = async (chunk: string): Promise<void> => {
    if (chunk.length === 0) return
    hash.update(chunk, 'utf8')
    bytes += Buffer.byteLength(chunk, 'utf8')
    await spool.push(chunk)
  }
  try {
    for await (const chunk of body.read()) await take(normalizer.push(chunk))
    await take(normalizer.flush())
  } catch (error) {
    await spool.discard()
    throw error
  }
  return { spool, bytes, contentHash: hash.digest('hex') }
}

async function message(role: 'user' | 'assistant', body: Body | undefined,
  registry: SpoolRegistry, steerMessageId?: string): Promise<StreamedMessage | undefined> {
  if (!body || body.bytes === 0) return undefined
  const sealed = await sealBody(body, registry)
  if (sealed.bytes === 0) {
    await sealed.spool.discard()
    return undefined
  }
  const spool = sealed.spool
  // Consuming the message frees its storage; an abandoned message is freed by the pass.
  const text = (async function* (): AsyncGenerator<string> {
    try {
      yield* spool.read()
    } finally {
      await spool.discard()
      registry.release(spool)
    }
  })()
  return {
    role, text, contentHash: sealed.contentHash, bytes: sealed.bytes,
    ...(steerMessageId === undefined ? {} : { steerMessageId })
  }
}

/** Ordered visible messages of one turn; the caller must consume or discard every spool. */
async function assembleTurn(userData: string, cwd: string, registry: SpoolRegistry, parts: readonly Part[]): Promise<StreamedMessage[]> {
  const messages: StreamedMessage[] = []
  const prompt = parts.find((part): part is Extract<Part, { kind: 'user' }> => part.kind === 'user')
  const user = await message('user', prompt ? spoolBody(prompt.spool) : undefined, registry)
  if (user) messages.push(user)
  let slice: Part[] = []
  let steers = 0
  for (const part of parts) {
    if (part.kind === 'user') continue
    if (part.kind !== 'steer' || part.status !== 'accepted') {
      slice.push(part)
      continue
    }
    const settled = await message('assistant', await sliceBody(userData, cwd, slice), registry)
    if (settled) messages.push(settled)
    slice = []
    steers += 1
    const steer = await message('user', spoolBody(part.spool), registry, part.messageId)
    if (steer) messages.push(steer)
  }
  const tail = await message('assistant', await sliceBody(userData, cwd, slice), registry)
  if (tail) messages.push(tail)
  if (steers > 0 && messages.at(-1)?.role === 'user') {
    throw new Error('该轮最后一条已接受的追加输入没有可见助手回复，不能证明消息顺序与轮次收敛，不能创建侧聊')
  }
  return messages
}

/**
 * Streams one turn at a time. A turn is yielded only once its header proves identity and
 * completion evidence, so a caller never freezes a turn whose provenance is still open.
 */
export async function* streamTurns(
  userData: string,
  cwd: string,
  entries: AsyncIterable<ArchiveEntry>,
  budget: SpoolBudget = { available: 4 * 1024 * 1024 }
): AsyncGenerator<StreamedTurn> {
  const registry = new SpoolRegistry(budget)
  let parts: Part[] = []
  let userSpool: TextSpool | undefined
  let events = new Map<number, Extract<Part, { kind: 'event' }>>()
  let steers = new Map<number, Extract<Part, { kind: 'steer' }>>()
  const reset = (): void => {
    parts = []
    userSpool = undefined
    events = new Map()
    steers = new Map()
  }
  try {
    for await (const entry of entries) {
      if (entry.type === 'turn') {
        // The bodies are sealed from these inputs, so the sink's read never comes back here.
        const messages = await assembleTurn(userData, cwd, registry, parts)
        const status = entry.status ?? 'completed'
        try {
          yield {
            runId: entry.runId,
            ...(entry.providerTurnId === undefined ? {} : { providerTurnId: entry.providerTurnId }),
            status, settled: entry.done && status === 'completed', messages
          }
        } finally {
          // Runs once the sink has consumed this turn, and also when the caller abandons or
          // fails the generator: either way this turn's inputs are done, and their budget
          // charge and spill files are handed back before the references are dropped.
          await discardSpools(inputSpools(parts, userSpool))
        }
        reset()
        continue
      }
      if (entry.type === 'user') {
        userSpool ??= new TextSpool(256 * 1024, budget)
        if (!parts.some(part => part.kind === 'user')) parts.push({ kind: 'user', spool: userSpool })
        await userSpool.push(entry.chunk)
        continue
      }
      if (entry.type === 'break') {
        parts.push({ kind: 'break' })
        continue
      }
      if (entry.type === 'body') {
        const event = events.get(entry.event)
        if (event) event.body = entry.body
        continue
      }
      if (entry.type === 'steer') {
        let steer = steers.get(entry.event)
        if (!steer) {
          steer = {
            kind: 'steer', event: entry.event, status: entry.status, spool: new TextSpool(256 * 1024, budget),
            ...(entry.messageId === undefined ? {} : { messageId: entry.messageId })
          }
          steers.set(entry.event, steer)
          parts.push(steer)
        }
        await steer.spool.push(entry.chunk)
        continue
      }
      let event = events.get(entry.event)
      if (!event) {
        event = {
          kind: 'event', event: entry.event, stage: entry.stage, replaces: entry.replacesStreamedText === true,
          spool: new TextSpool(256 * 1024, budget),
          ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
          ...(entry.codexItemId === undefined ? {} : { codexItemId: entry.codexItemId })
        }
        events.set(entry.event, event)
        parts.push(event)
      }
      await event.spool.push(entry.chunk)
    }
  } finally {
    // Whatever was still being built when the pass ended; already-discarded spools are no-ops.
    await discardSpools(inputSpools(parts, userSpool))
    await registry.discardAll()
  }
}
