import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import type { FileHandle } from 'node:fs/promises'
import { parser, type Token } from 'stream-json/parser.js'
import { TextSpool } from './text-spool'
import {
  BODY_KEYS, REF_KEYS, assertArchiveIdentity, assertProvider, factsOf, keepText, parseScalar, primitiveValue
} from './trace-archive-fields'

/**
 * Selective, bounded-memory projection of an archived session file.
 *
 * One archived turn can be hundreds of MiB because it stores every tool diff, hook
 * payload and preview verbatim. Side-chat capture needs only visible text and steer
 * evidence, so this reader walks the file as a JSON token stream and never materializes
 * a value it will not use.
 *
 * Text is streamed, not accumulated: a visible body is spooled (memory up to a bound,
 * then a private temporary file) and emitted as bounded chunks, so a 200 MiB body never
 * becomes one string. Selection is decided by the structural key path and by the event's
 * own `kind`/`stage`, never by text inside a payload, so a tool result whose body contains
 * `"stage":"text"` cannot select itself.
 *
 * This is a real JSON parse: malformed, truncated or re-identified files fail closed
 * instead of producing a partial snapshot.
 */

/** Provenance of one stored visible body, projected field by field. */
export interface ArchiveBodyFacts {
  source?: string
  encoding?: string
  sourceCompleteness?: string
  redaction?: string
  storage?: string
  contentRef?: { storage?: string; sha256?: string; bytes?: number; encoding?: string }
}

export type ArchiveEntry =
  /** Turn header, emitted after its chunks: the body fixes run identity first. */
  | { type: 'turn'; turn: number; runId: string; providerTurnId?: string; ts: number; done: boolean; status?: string }
  | { type: 'user'; turn: number; chunk: string }
  | {
      type: 'text'
      turn: number
      /** Monotonic event number inside the file; chunks of one event share it. */
      event: number
      stage: string
      messageId?: string
      codexItemId?: string
      replacesStreamedText?: boolean
      chunk: string
    }
  /** The event carries a `modelContent` envelope; inline chunks above are its body. */
  | { type: 'body'; turn: number; event: number; body: ArchiveBodyFacts }
  | { type: 'steer'; turn: number; event: number; status: string; messageId?: string; chunk: string }
  /** An event that is not a visible body: it ends any preceding assistant text group. */
  | { type: 'break'; turn: number; event: number }

export interface ArchiveTurnExpectation {
  cwd: string
  sessionId: string
  providerId: string
  /** A canonical turn segment carries exactly one turn; a legacy file carries many. */
  turnCount: 'single' | 'many'
  /** Only checked for single-turn segments. */
  runId?: string
  providerTurnId?: string
}

/** Stability evidence for the bytes that were actually read. */
export interface ArchiveReadEvidence {
  bytesRead: number
  digest: string
}

export interface ProjectionOptions {
  /** Only the turn header is needed; bodies are skipped entirely. */
  metadataOnly?: boolean
}

/** Turn-level scalars; every other root/turn field is skipped. */
const TURN_KEYS = new Set(['runId', 'providerTurnId', 'ts', 'done', 'status', 'providerId', 'runtimeProvider'])
const ROOT_KEYS = new Set(['version', 'cwd', 'sessionId', 'externalSessionId', 'providerId', 'runtimeProvider'])
/** Event scalars that decide whether the event is visible at all. */
const EVENT_KEYS = new Set([
  'id', 'kind', 'stage', 'runId', 'messageId', 'agentId', 'parentToolUseId', 'ts', 'providerId', 'runtimeProvider'
])
const STEER_KEYS = new Set(['status', 'messageId'])
const RUNTIME_KEYS = new Set(['replacesStreamedText', 'codexItemId'])

type Role = 'root' | 'turns' | 'turn' | 'items' | 'event' | 'steer' | 'runtime' | 'content' | 'contentRef' | 'ignored'
type SpoolTarget = 'user' | 'text' | 'steer'

function roleOf(parent: Role | undefined, key: string | null, token: Token): Role {
  if (!parent) return 'root'
  const child = token.name === 'startObject' || token.name === 'startArray'
  if (parent === 'root' && key === 'turns' && child) return 'turns'
  if (parent === 'turns' && token.name === 'startObject') return 'turn'
  if (parent === 'turn' && key === 'items' && child) return 'items'
  if (parent === 'items' && token.name === 'startObject') return 'event'
  if (parent === 'event' && key === 'steer' && token.name === 'startObject') return 'steer'
  if (parent === 'event' && key === 'runtimeMetadata' && token.name === 'startObject') return 'runtime'
  if (parent === 'event' && key === 'modelContent' && token.name === 'startObject') return 'content'
  if (parent === 'content' && key === 'contentRef' && token.name === 'startObject') return 'contentRef'
  return 'ignored'
}

interface Frame {
  role: Role
  key: string | null
}

/**
 * Project every turn of one archive file, as ordered entries.
 *
 * `evidence` is filled with the digest of exactly the bytes that were parsed, so a
 * caller that re-reads the same file can prove both passes saw identical content.
 */
export async function* iterateArchiveEntries(
  handle: FileHandle,
  size: number,
  expectation: ArchiveTurnExpectation,
  evidence: ArchiveReadEvidence,
  options: ProjectionOptions = {}
): AsyncGenerator<ArchiveEntry> {
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  const source = handle.createReadStream({ start: 0, end: size - 1, autoClose: false })
    .pipe(tap).pipe(parser.asStream({ packStrings: false, packNumbers: false }))

  const rootValues = new Map<string, unknown>()
  let turnValues = new Map<string, unknown>()
  let eventMeta = new Map<string, unknown>()
  let steerMeta = new Map<string, unknown>()
  let bodyFields = new Map<string, unknown>()
  let refFields = new Map<string, unknown>()
  let hasBody = false
  const frames: Frame[] = []
  let depth = 0
  let turnDepth = -1
  let scalar: { target: Map<string, unknown>; key: string } | undefined
  let pending: { kind: 'string' | 'number'; parts: string[] } | undefined
  let skipDepth = 0
  let skipPrimitive = false
  /** Key characters arrive as string chunks before their `keyValue` token. */
  let inKey = false
  const spool = new TextSpool()
  let spoolTarget: SpoolTarget | undefined
  /** The key whose value is being spooled; every other key takes the scalar path. */
  let spoolKey: string | undefined
  let rootClosed = false
  let turns = 0
  let eventNumber = 0
  let userTextSeen = false

  const finishScalar = (): void => {
    if (!scalar) return
    scalar.target.set(scalar.key, parseScalar(pending?.parts.join('') ?? '', pending?.kind))
    scalar = undefined
    pending = undefined
  }

  /** Emits the spooled body of the value that just ended, then frees its storage. */
  const spoolingNow = (): boolean => spoolTarget !== undefined && frames.at(-1)?.key === spoolKey

  const flush = async function* (): AsyncGenerator<ArchiveEntry> {
    const target = spoolTarget
    spoolTarget = undefined
    spoolKey = undefined
    if (target === undefined) return
    try {
      if (target === 'user') {
        for await (const chunk of spool.read()) yield { type: 'user', turn: turns, chunk }
        return
      }
      if (target === 'steer') {
        const status = steerMeta.get('status')
        const messageId = steerMeta.get('messageId')
        for await (const chunk of spool.read()) {
          yield {
            type: 'steer', turn: turns, event: eventNumber,
            status: typeof status === 'string' ? status : 'unknown',
            ...(typeof messageId === 'string' ? { messageId } : {}), chunk
          }
        }
        return
      }
      if (!keepText(eventMeta)) return
      for await (const chunk of spool.read()) {
        yield {
          type: 'text', turn: turns, event: eventNumber, stage: String(eventMeta.get('stage') ?? ''),
          ...(typeof eventMeta.get('messageId') === 'string' ? { messageId: eventMeta.get('messageId') as string } : {}),
          ...(typeof eventMeta.get('codexItemId') === 'string' ? { codexItemId: eventMeta.get('codexItemId') as string } : {}),
          ...(eventMeta.get('replacesStreamedText') === true ? { replacesStreamedText: true } : {}),
          chunk
        }
      }
    } finally {
      await spool.discard()
    }
  }

  /** One event ended: its text, its body provenance, or the break it makes in text runs. */
  const closeEvent = async function* (): AsyncGenerator<ArchiveEntry> {
    finishScalar()
    for await (const entry of flush()) yield entry
    const visible = keepText(eventMeta)
    assertProvider(expectation, {
      providerId: eventMeta.get('providerId'), runtimeProvider: eventMeta.get('runtimeProvider')
    })
    const runId = eventMeta.get('runId')
    if (runId !== undefined && runId !== turnValues.get('runId')) {
      throw new Error('trace archive event belongs to another run')
    }
    const kind = eventMeta.get('kind')
    if (kind !== undefined && typeof kind !== 'string') throw new Error('trace archive event kind is invalid')
    const stage = eventMeta.get('stage')
    if (stage !== undefined && typeof stage !== 'string') throw new Error('trace archive event stage is invalid')
    if (!visible) {
      yield { type: 'break', turn: turns, event: eventNumber }
      return
    }
    if (!hasBody) return
    yield { type: 'body', turn: turns, event: eventNumber, body: factsOf(new Map([...bodyFields, ['contentRef', refFields]])) }
  }

  const finishTurn = (): ArchiveEntry => {
    assertProvider(expectation, {
      providerId: turnValues.get('providerId'), runtimeProvider: turnValues.get('runtimeProvider')
    })
    const runId = turnValues.get('runId')
    if (typeof runId !== 'string' || runId.length === 0) throw new Error('trace archive turn has no run identity')
    if (expectation.runId !== undefined && runId !== expectation.runId) {
      throw new Error('trace archive segment belongs to another run')
    }
    const providerTurnId = turnValues.get('providerTurnId')
    if (providerTurnId !== undefined && typeof providerTurnId !== 'string') throw new Error('trace archive provider turn id is invalid')
    if (expectation.providerTurnId !== undefined && providerTurnId !== expectation.providerTurnId) {
      throw new Error('trace archive segment changed or belongs to another Provider turn')
    }
    const ts = turnValues.get('ts')
    if (typeof ts !== 'number' || !Number.isFinite(ts)) throw new Error('trace archive turn has no timestamp')
    const done = turnValues.get('done')
    if (typeof done !== 'boolean') throw new Error('trace archive turn has no completion evidence')
    const status = turnValues.get('status')
    if (status !== undefined && typeof status !== 'string') throw new Error('trace archive turn status is invalid')
    if (!userTextSeen) throw new Error('trace archive turn has no user text')
    turnValues = new Map()
    userTextSeen = false
    return {
      type: 'turn', turn: turns, runId, ...(providerTurnId !== undefined ? { providerTurnId } : {}), ts, done,
      ...(status !== undefined ? { status } : {})
    }
  }

  try {
    for await (const token of source as AsyncIterable<Token>) {
      if (skipPrimitive) {
        if (token.name === 'endString' || token.name === 'endNumber') skipPrimitive = false
        continue
      }
      if (skipDepth > 0) {
        if (token.name === 'startObject' || token.name === 'startArray') skipDepth += 1
        else if (token.name === 'endObject' || token.name === 'endArray') skipDepth -= 1
        continue
      }
      if (token.name === 'startKey') {
        inKey = true
        continue
      }
      if (token.name === 'endKey') {
        inKey = false
        continue
      }
      if (token.name === 'keyValue') {
        finishScalar()
        const frame = frames.at(-1)
        if (!frame) throw new Error('trace archive key outside an object')
        const key = token.value as string
        frame.key = key
        const role = frame.role
        const skip = options.metadataOnly
        if (role === 'root' && ROOT_KEYS.has(key)) scalar = { target: rootValues, key }
        else if (role === 'turn' && key === 'userText') {
          userTextSeen = true
          if (!skip) {
            spoolTarget = 'user'
            spoolKey = key
          }
        } else if (role === 'turn' && TURN_KEYS.has(key)) scalar = { target: turnValues, key }
        else if (role === 'event' && key === 'text' && !skip) {
          if (!hasBody) {
            spoolTarget = 'text'
            spoolKey = key
          }
        } else if (role === 'event' && key === 'modelContent') hasBody = true
        else if (role === 'event' && EVENT_KEYS.has(key)) scalar = { target: eventMeta, key }
        else if (role === 'steer' && key === 'prompt' && !skip) {
          spoolTarget = 'steer'
          spoolKey = key
        }
        else if (role === 'steer' && STEER_KEYS.has(key)) scalar = { target: steerMeta, key }
        else if (role === 'runtime' && RUNTIME_KEYS.has(key)) scalar = { target: eventMeta, key }
        else if (role === 'content' && key === 'content' && !skip) {
          spoolTarget = 'text'
          spoolKey = key
        }
        else if (role === 'content' && BODY_KEYS.has(key)) scalar = { target: bodyFields, key }
        else if (role === 'contentRef' && REF_KEYS.has(key)) scalar = { target: refFields, key }
        continue
      }
      if (token.name === 'stringChunk') {
        if (inKey) continue
        if (spoolingNow()) await spool.push(token.value as string)
        else if (pending) pending.parts.push(token.value as string)
        continue
      }
      if (token.name === 'numberChunk') {
        if (pending) pending.parts.push(token.value as string)
        continue
      }
      if (token.name === 'startString' || token.name === 'startNumber') {
        if (spoolingNow()) continue
        if (scalar) pending = { kind: token.name === 'startString' ? 'string' : 'number', parts: [] }
        else skipPrimitive = true
        continue
      }
      if (token.name === 'endString' || token.name === 'endNumber') {
        if (pending) finishScalar()
        // User text is unconditional, so it can be emitted as soon as its string ends.
        if (spoolingNow() && spoolTarget === 'user') for await (const entry of flush()) yield entry
        continue
      }
      if (token.name === 'endObject' || token.name === 'endArray') {
        const frame = frames.pop()
        if (!frame) throw new Error('trace archive JSON closes outside a value')
        depth -= 1
        if (frame.role === 'steer') {
          finishScalar()
          for await (const entry of flush()) yield entry
        } else if (frame.role === 'event') {
          for await (const entry of closeEvent()) yield entry
        } else if (frame.role === 'turn') {
          finishScalar()
          if (spoolingNow() && spoolTarget === 'user') for await (const entry of flush()) yield entry
          if (depth !== turnDepth) throw new Error('trace archive turn nesting is invalid')
          yield finishTurn()
        } else if (frame.role === 'root') rootClosed = true
        continue
      }
      if (token.name !== 'startObject' && token.name !== 'startArray') {
        if (scalar) {
          scalar.target.set(scalar.key, primitiveValue(token))
          scalar = undefined
        }
        continue
      }
      scalar = undefined
      pending = undefined
      const parentRole = frames.at(-1)?.role
      const role = roleOf(parentRole, frames.at(-1)?.key ?? null, token)
      if (role === 'ignored') {
        skipDepth = 1
        continue
      }
      // A stored body or a steer prompt supersedes inline text for this event.
      if ((role === 'content' || role === 'steer') && spoolTarget === 'text') {
        spoolTarget = undefined
        spoolKey = undefined
        await spool.discard()
      }
      frames.push({ role, key: null })
      depth += 1
      if (role === 'turn') {
        turns += 1
        turnDepth = depth - 1
        turnValues = new Map()
        eventMeta = new Map()
        steerMeta = new Map()
        userTextSeen = false
      }
      if (role === 'event') {
        eventNumber += 1
        eventMeta = new Map()
        steerMeta = new Map()
        bodyFields = new Map()
        refFields = new Map()
        hasBody = false
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('trace archive')) throw error
    throw new Error(`trace archive JSON is corrupt or truncated: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await spool.discard()
  }
  if (!rootClosed) throw new Error('trace archive JSON is truncated')
  assertArchiveIdentity(rootValues, expectation)
  if (expectation.turnCount === 'single' && turns !== 1) {
    throw new Error('trace archive segment must contain exactly one turn')
  }
  evidence.bytesRead = size
  evidence.digest = hash.digest('hex')
}
