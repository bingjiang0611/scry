import { projectJsonlRecords, type RecordProjector, type Token, type TranscriptReadEvidence } from './jsonl-record-scanner'

/**
 * Pi session records, projected to what a side chat keeps.
 *
 * Pi names its identity once, in the session header (`type: 'session'`, `version: 3`, `id`,
 * `cwd`), and then writes message records that hang off their `parentId`. That differs from
 * Claude, which repeats `sessionId` on every record; the header here is the whole identity
 * proof.
 *
 * Only the key path below is tracked and every other value is consumed as tokens and
 * dropped, so a tool result or an image payload of any size never becomes a JSON value.
 * `metadata` mode reads structure only; `body` mode additionally lets string content leave as
 * it arrives so the caller can spool a visible body instead of accumulating it. Neither mode
 * turns a value into a tree, and a key that cannot match a known field stops being collected
 * instead of growing.
 */

export type PiScalarSlot =
  | 'root.type'
  | 'root.id'
  | 'root.parentId'
  | 'root.version'
  | 'root.cwd'
  | 'root.timestamp'
  | 'message.role'
  | 'message.stopReason'
  | 'message.toolCallId'
  | 'message.toolName'
  | 'message.isError'
  | 'block.type'

export type PiScalarKind = 'string' | 'number' | 'boolean' | 'null'

/** One projected piece of a Pi record, in document order. */
export type PiJsonlEvent =
  | { t: 'beginRecord' }
  | { t: 'scalar'; slot: PiScalarSlot; raw: string; kind: PiScalarKind }
  | { t: 'beginBlock' }
  | { t: 'text'; text: string }
  | { t: 'endBlock' }
  | { t: 'endRecord' }

export type PiProjectionMode = 'metadata' | 'body'

type Role = 'root' | 'message' | 'content' | 'block' | 'skip'

const ROOT_SCALARS: Record<string, PiScalarSlot> = {
  type: 'root.type', id: 'root.id', parentId: 'root.parentId', version: 'root.version',
  cwd: 'root.cwd', timestamp: 'root.timestamp'
}
const ROOT_FIELDS = new Set([...Object.keys(ROOT_SCALARS), 'message'])
const MESSAGE_SCALARS: Record<string, PiScalarSlot> = {
  role: 'message.role', stopReason: 'message.stopReason', toolCallId: 'message.toolCallId',
  toolName: 'message.toolName', isError: 'message.isError'
}
const MESSAGE_FIELDS = new Set([...Object.keys(MESSAGE_SCALARS), 'content'])
const BLOCK_FIELDS = new Set(['type', 'text'])
const NO_FIELDS = new Set<string>()

/** Longest known field name; a longer key cannot match and stops being collected. */
const LONGEST_FIELD = 12
/** A projected scalar is a structural field of Pi's record, not a body. */
const MAX_SCALAR_CHARS = 64 * 1024

interface Capture {
  kind: 'scalar' | 'text'
  /** A scalar keeps the JSON kind it was written with: `version` is a number. */
  valueKind?: 'string' | 'number'
  slot?: PiScalarSlot
  text: string
}

/** Projects one Pi record stream at the requested depth. */
export class PiRecordProjector implements RecordProjector<PiJsonlEvent> {
  private readonly roles: Role[] = []
  private readonly events: PiJsonlEvent[] = []
  private key: string | null = null
  private keyCandidates: Set<string> = NO_FIELDS
  private keyPrefix = ''
  private inKey = false
  private capture?: Capture

  constructor(private readonly mode: PiProjectionMode) {}

  accept(token: Token): PiJsonlEvent[] {
    this.events.length = 0
    switch (token.name) {
      case 'startObject': this.start('object'); break
      case 'startArray': this.start('array'); break
      case 'endObject':
      case 'endArray': this.end(); break
      case 'startKey': this.beginKey(); break
      case 'stringChunk': this.chunk(token.value as string); break
      case 'endKey': this.endKey(); break
      case 'startString': this.beginValue('string'); break
      case 'endString': this.endValue(); break
      case 'startNumber': this.beginValue('number'); break
      case 'numberChunk': this.chunk(token.value as string); break
      case 'endNumber': this.endValue(); break
      case 'trueValue': this.literal('true', 'boolean'); break
      case 'falseValue': this.literal('false', 'boolean'); break
      case 'nullValue': this.literal('null', 'null'); break
      default: break
    }
    return this.events
  }

  private start(kind: 'object' | 'array'): void {
    if (this.roles.length === 0) {
      if (kind !== 'object') throw new Error('原生会话记录不是 JSON 对象')
      this.roles.push('root')
      this.key = null
      this.events.push({ t: 'beginRecord' })
      return
    }
    const role = this.childRole(kind)
    if (kind === 'object' && role === 'block') this.events.push({ t: 'beginBlock' })
    this.roles.push(role)
    this.key = null
  }

  private end(): void {
    const role = this.roles.pop()
    if (role === 'block') this.events.push({ t: 'endBlock' })
    this.key = null
    this.capture = undefined
    if (this.roles.length === 0) this.events.push({ t: 'endRecord' })
  }

  private childRole(kind: 'object' | 'array'): Role {
    const parent = this.roles.at(-1)
    if (parent === 'root') return this.key === 'message' && kind === 'object' ? 'message' : 'skip'
    if (parent === 'message') return this.key === 'content' && kind === 'array' ? 'content' : 'skip'
    if (parent === 'content') return kind === 'object' ? 'block' : 'skip'
    return 'skip'
  }

  private beginKey(): void {
    this.inKey = true
    this.keyPrefix = ''
    const parent = this.roles.at(-1)
    this.keyCandidates = parent === 'root' ? ROOT_FIELDS
      : parent === 'message' ? MESSAGE_FIELDS
        : parent === 'block' ? BLOCK_FIELDS
          : NO_FIELDS
  }

  private endKey(): void {
    this.inKey = false
    this.key = this.keyCandidates.size === 1 ? [...this.keyCandidates][0] : null
    this.keyPrefix = ''
  }

  /** A key that cannot match a known field stops being collected instead of growing. */
  private chunk(text: string): void {
    if (this.inKey) {
      if (this.keyCandidates.size === 0) return
      this.keyPrefix += text
      if (this.keyPrefix.length > LONGEST_FIELD) {
        this.keyCandidates = NO_FIELDS
        this.keyPrefix = ''
        return
      }
      const prefix = this.keyPrefix
      this.keyCandidates = new Set([...this.keyCandidates].filter(field => field.startsWith(prefix)))
      return
    }
    if (!this.capture) return
    if (this.capture.kind === 'text') {
      this.events.push({ t: 'text', text })
      return
    }
    if (this.capture.text.length + text.length > MAX_SCALAR_CHARS) {
      throw new Error('原生会话记录字段值不符合该 Provider 的格式')
    }
    this.capture.text += text
  }

  private beginValue(kind: 'string' | 'number'): void {
    const parent = this.roles.at(-1)
    if (parent === 'skip' || this.key === null) return
    const slot = this.scalarSlot()
    if (slot !== undefined) {
      this.capture = { kind: 'scalar', slot, valueKind: kind, text: '' }
      return
    }
    // Bodies leave only in body mode, and only from `message.content`: a `text` key inside a
    // content block, or the string form of the content itself.
    if (this.mode !== 'body' || kind !== 'string') return
    const body = (parent === 'block' && this.key === 'text') ||
      (parent === 'message' && this.key === 'content')
    if (body) this.capture = { kind: 'text', text: '' }
  }

  private literal(raw: string, kind: 'boolean' | 'null'): void {
    const slot = this.scalarSlot()
    if (slot === undefined) return
    this.events.push({ t: 'scalar', slot, raw, kind })
  }

  private endValue(): void {
    const capture = this.capture
    this.capture = undefined
    if (capture?.kind === 'scalar' && capture.slot) {
      this.events.push({ t: 'scalar', slot: capture.slot, raw: capture.text, kind: capture.valueKind ?? 'string' })
    }
  }

  private scalarSlot(): PiScalarSlot | undefined {
    const parent = this.roles.at(-1)
    if (parent === 'root' && this.key !== null) return ROOT_SCALARS[this.key]
    if (parent === 'message' && this.key !== null) return MESSAGE_SCALARS[this.key]
    if (parent === 'block' && this.key === 'type') return 'block.type'
    return undefined
  }
}

/** Pi session records, in document order, up to `size` bytes. */
export async function* projectPiRecords(
  handle: Parameters<typeof projectJsonlRecords>[0],
  size: number,
  evidence: TranscriptReadEvidence,
  mode: PiProjectionMode
): AsyncGenerator<PiJsonlEvent> {
  yield* projectJsonlRecords(handle, size, () => new PiRecordProjector(mode), evidence)
}
