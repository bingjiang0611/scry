import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import type { FileHandle } from 'node:fs/promises'
import { parser, type Token } from 'stream-json/parser.js'
import type { TraceEvent } from '../shared/trace'
import { providerIdForRuntime, type RuntimeProvider } from '../shared/runtime'

/**
 * Selective, bounded-memory projection of an archived session file.
 *
 * One archived turn can be hundreds of MiB because it stores every tool diff, hook
 * payload and preview verbatim. Side-chat capture only needs visible text and steer
 * evidence, so this reader walks the file as a JSON token stream and never keeps a
 * value it will not use. Selection is decided by the structural key path, never by
 * text inside a payload, so a tool result whose body contains `"stage":"text"`
 * cannot select itself.
 *
 * This is a real JSON parse: malformed, truncated or re-identified files fail
 * closed instead of producing a partial snapshot.
 */
export interface ArchiveTurnProjection {
  runId: string
  providerTurnId?: string
  ts: number
  done: boolean
  status?: string
  userText: string
  events: TraceEvent[]
}

/** Event fields capture reads; every other event field is skipped, not materialized. */
const EVENT_KEYS = new Set([
  'id', 'kind', 'stage', 'runId', 'messageId', 'agentId', 'parentToolUseId', 'ts',
  'text', 'modelContent', 'steer', 'runtimeMetadata', 'providerId', 'runtimeProvider'
])
/** Turn-level scalars; `items` is walked event by event. */
const TURN_KEYS = new Set(['runId', 'providerTurnId', 'userText', 'ts', 'done', 'status'])
const ROOT_KEYS = new Set(['version', 'cwd', 'sessionId', 'externalSessionId', 'providerId', 'runtimeProvider'])

type Role = 'root' | 'turns' | 'turn' | 'items' | 'event' | 'ignored'

interface BuilderFrame {
  kind: 'object' | 'array'
  value: Record<string, unknown> | unknown[]
  key: string | null
}

interface Builder {
  stack: BuilderFrame[]
  skipDepth: number
  skipPrimitive: boolean
  skipNextValue: boolean
  pending: { kind: 'string' | 'number'; parts: string[] } | undefined
}

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

function roleOf(parent: Role | undefined, key: string | null, token: Token): Role {
  if (!parent) return 'root'
  if (parent === 'root' && key === 'turns' && token.name === 'startArray') return 'turns'
  if (parent === 'turns' && token.name === 'startObject') return 'turn'
  if (parent === 'turn' && key === 'items' && token.name === 'startArray') return 'items'
  if (parent === 'items' && token.name === 'startObject') return 'event'
  return 'ignored'
}

function isPrimitiveStart(token: Token): boolean {
  return token.name === 'startString' || token.name === 'startNumber' ||
    token.name === 'trueValue' || token.name === 'falseValue' || token.name === 'nullValue' ||
    token.name === 'stringValue' || token.name === 'numberValue'
}

function primitiveValue(token: Token): unknown {
  if (token.name === 'trueValue') return true
  if (token.name === 'falseValue') return false
  if (token.name === 'nullValue') return null
  if (token.name === 'stringValue' || token.name === 'numberValue') return token.value
  return undefined
}

/** Only visible assistant text and steer evidence are projected into the snapshot. */
function keepEvent(event: TraceEvent): boolean {
  if (event.stage === 'steer') return true
  return event.kind === 'model' && (event.stage === 'text' || event.stage === 'text_delta') &&
    event.agentId == null && event.parentToolUseId == null
}

function assertProvider(expectation: ArchiveTurnExpectation, raw: { providerId?: unknown; runtimeProvider?: unknown }): void {
  if (raw.providerId !== undefined && raw.providerId !== expectation.providerId) {
    throw new Error('trace archive belongs to another Provider')
  }
  if (raw.runtimeProvider !== undefined &&
    providerIdForRuntime(raw.runtimeProvider as RuntimeProvider) !== expectation.providerId) {
    throw new Error('trace archive runtime belongs to another Provider')
  }
}

export interface ProjectionOptions {
  /** Only the turn metadata is needed; event bodies are skipped entirely. */
  metadataOnly?: boolean
}

/**
 * Project every turn of one archive file, in file order.
 *
 * `evidence` is filled with the digest of exactly the bytes that were parsed, so a
 * caller that re-reads the same file can prove both passes saw identical content.
 * The read is bounded by the largest single value the projection keeps, not by the
 * file size.
 */
export async function* iterateArchiveTurnProjections(
  handle: FileHandle,
  size: number,
  expectation: ArchiveTurnExpectation,
  evidence: ArchiveReadEvidence,
  options: ProjectionOptions = {}
): AsyncGenerator<ArchiveTurnProjection> {
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
  let events: TraceEvent[] = []
  const roles: Role[] = []
  const keys: (string | null)[] = []
  let depth = 0
  let turnDepth = -1
  let scalar: { target: Map<string, unknown>; key: string } | undefined
  let pending: { kind: 'string' | 'number'; parts: string[] } | undefined
  let builder: Builder | undefined
  let rootClosed = false
  let turnCount = 0

  const finishEvent = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('trace archive event is not an object')
    const event = value as TraceEvent
    if (typeof event.stage !== 'string') throw new Error('trace archive event has no stage')
    if (event.kind !== undefined && typeof event.kind !== 'string') throw new Error('trace archive event kind is invalid')
    if (event.runId !== turnValues.get('runId')) throw new Error('trace archive event belongs to another run')
    assertProvider(expectation, { providerId: event.providerId, runtimeProvider: event.runtimeProvider })
    if (keepEvent(event)) events.push(event)
  }

  const finishScalar = (): void => {
    if (!scalar) return
    const raw = pending?.parts.join('') ?? ''
    scalar.target.set(scalar.key, parseScalar(raw, pending?.kind))
    scalar = undefined
    pending = undefined
  }

  const finishTurn = (): ArchiveTurnProjection => {
    turnCount += 1
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
    const userText = turnValues.get('userText')
    if (typeof userText !== 'string') throw new Error('trace archive turn has no user text')
    const projection: ArchiveTurnProjection = {
      runId, ...(providerTurnId !== undefined ? { providerTurnId } : {}), ts, done,
      ...(status !== undefined ? { status } : {}), userText, events
    }
    turnValues = new Map()
    events = []
    return projection
  }

  try {
    for await (const token of source as AsyncIterable<Token>) {
      if (builder) {
        const finished = applyBuilderToken(builder, token)
        if (finished !== undefined) {
          builder = undefined
          finishEvent(finished)
        }
        continue
      }
      if (token.name === 'keyValue') {
        finishScalar()
        if (depth === 0) throw new Error('trace archive key outside an object')
        keys[depth - 1] = token.value
        const role = roles[depth - 1]
        if ((role === 'root' && ROOT_KEYS.has(token.value)) || (role === 'turn' && TURN_KEYS.has(token.value))) {
          scalar = { target: role === 'root' ? rootValues : turnValues, key: token.value }
        }
        continue
      }
      if (isPrimitiveStart(token)) {
        if (scalar) {
          if (token.name === 'startString') pending = { kind: 'string', parts: [] }
          else if (token.name === 'startNumber') pending = { kind: 'number', parts: [] }
          else {
            scalar.target.set(scalar.key, primitiveValue(token))
            scalar = undefined
            pending = undefined
          }
        }
        continue
      }
      if (token.name === 'stringChunk' || token.name === 'numberChunk') {
        if (pending) pending.parts.push(token.value as string)
        continue
      }
      if (token.name === 'endString' || token.name === 'endNumber') {
        if (pending) finishScalar()
        continue
      }
      if (token.name === 'startObject' || token.name === 'startArray') {
        const role = roleOf(roles[depth - 1], keys[depth - 1] ?? null, token)
        if (role === 'event' && !options.metadataOnly) {
          if (roles.length !== 4) throw new Error('trace archive items are not under a turn')
          builder = { stack: [], skipDepth: 0, skipPrimitive: false, skipNextValue: false, pending: undefined }
          const root = applyBuilderToken(builder, token)
          if (root !== undefined) throw new Error('trace archive event is not an object')
          continue
        }
        roles.push(role)
        keys.push(null)
        depth += 1
        if (role === 'turn') {
          turnDepth = depth - 1
          turnValues = new Map()
          events = []
        }
        if (role === 'turns') turnCount = 0
        continue
      }
      if (token.name === 'endObject' || token.name === 'endArray') {
        if (depth === 0) throw new Error('trace archive JSON closes outside a value')
        depth -= 1
        roles.pop()
        keys.pop()
        if (depth === turnDepth) yield finishTurn()
        if (depth === 0) rootClosed = true
        continue
      }
    }
  } catch (error) {
    // A tokenizer error is a real parse failure, not a reason to emit a partial turn.
    if (error instanceof Error && error.message.startsWith('trace archive')) throw error
    throw new Error(`trace archive JSON is corrupt or truncated: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!rootClosed) throw new Error('trace archive JSON is truncated')
  if (builder) throw new Error('trace archive JSON is truncated inside an event')
  assertArchiveIdentity(rootValues, expectation)
  if (expectation.turnCount === 'single' && turnCount !== 1) {
    throw new Error('trace archive segment must contain exactly one turn')
  }
  evidence.bytesRead = size
  evidence.digest = hash.digest('hex')
}

function parseScalar(raw: string, kind: 'string' | 'number' | undefined): unknown {
  if (kind === 'string') return raw
  if (kind === 'number') return raw === '' ? undefined : Number(raw)
  return JSON.parse(raw) as unknown
}

function assertArchiveIdentity(rootValues: Map<string, unknown>, expectation: ArchiveTurnExpectation): void {
  if (rootValues.get('version') !== 3) throw new Error('trace archive schema is invalid')
  if (rootValues.get('cwd') !== expectation.cwd) throw new Error('trace archive belongs to another workspace')
  const sessionId = rootValues.get('sessionId')
  const external = rootValues.get('externalSessionId')
  if (sessionId !== expectation.sessionId && external !== expectation.sessionId) {
    throw new Error('trace archive belongs to another session')
  }
  assertProvider(expectation, { providerId: rootValues.get('providerId'), runtimeProvider: rootValues.get('runtimeProvider') })
}

/** Consume one token of an `items[]` event; returns the finished event object. */
function applyBuilderToken(builder: Builder, token: Token): unknown {
  if (builder.skipPrimitive) {
    if (token.name === 'endString' || token.name === 'endNumber') builder.skipPrimitive = false
    return undefined
  }
  if (builder.skipDepth > 0) {
    if (token.name === 'startObject' || token.name === 'startArray') builder.skipDepth += 1
    else if (token.name === 'endObject' || token.name === 'endArray') builder.skipDepth -= 1
    return undefined
  }
  if (builder.pending) {
    if (token.name === 'stringChunk' || token.name === 'numberChunk') {
      builder.pending.parts.push(token.value as string)
      return undefined
    }
    if (token.name === 'endString' || token.name === 'endNumber') {
      const raw = builder.pending.parts.join('')
      const value = builder.pending.kind === 'string' ? raw : Number(raw)
      builder.pending = undefined
      const frame = builder.stack.at(-1)
      if (frame) assignTo(frame, value)
      return undefined
    }
  }
  if (token.name === 'endObject' || token.name === 'endArray') {
    const frame = builder.stack.pop()
    if (!frame) return undefined
    const parent = builder.stack.at(-1)
    if (!parent) return frame.value
    assignTo(parent, frame.value)
    return undefined
  }
  if (token.name === 'startObject' || token.name === 'startArray') {
    if (builder.skipNextValue) {
      builder.skipNextValue = false
      builder.skipDepth = 1
      return undefined
    }
    builder.stack.push({
      kind: token.name === 'startArray' ? 'array' : 'object',
      value: token.name === 'startArray' ? [] : {}, key: null
    })
    return undefined
  }
  const frame = builder.stack.at(-1)
  if (!frame) return undefined
  if (token.name === 'keyValue') {
    frame.key = token.value
    if (builder.stack.length === 1 && !EVENT_KEYS.has(token.value)) builder.skipNextValue = true
    return undefined
  }
  if (token.name === 'startString' || token.name === 'startNumber') {
    if (builder.skipNextValue) {
      builder.skipNextValue = false
      builder.skipPrimitive = true
      return undefined
    }
    builder.pending = { kind: token.name === 'startString' ? 'string' : 'number', parts: [] }
    return undefined
  }
  if (isPrimitiveStart(token)) {
    if (builder.skipNextValue) {
      builder.skipNextValue = false
      return undefined
    }
    assignTo(frame, primitiveValue(token))
  }
  return undefined
}

function assignTo(frame: BuilderFrame, value: unknown): void {
  if (frame.kind === 'object') (frame.value as Record<string, unknown>)[frame.key ?? ''] = value
  else (frame.value as unknown[]).push(value)
}
