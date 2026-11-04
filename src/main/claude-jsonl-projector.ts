import type { FileHandle } from 'node:fs/promises'
import { JsonlRecordError, projectJsonlRecords, type RecordProjector, type Token, type TranscriptReadEvidence } from './jsonl-record-scanner'

/**
 * Claude transcript records, projected to what a side chat keeps.
 *
 * Only the key path of the fields below is tracked; every other value is consumed as tokens
 * and dropped, so a whole tool result never becomes a value. Keys are matched incrementally
 * against the known field names of the current object: an unknown or arbitrarily long key
 * fails to match and its value is skipped, never rejected and never buffered. Body text
 * leaves as it arrives so the caller can spool a visible body instead of accumulating it.
 *
 * Claude names its session on every record (`sessionId`) and states the workspace once at
 * the root (`cwd`), which is what the identity check below reads.
 */

/** The only scalar fields a side chat projects, addressed by their JSON location. */
export type ScalarSlot =
  | 'root.type'
  | 'root.isMeta'
  | 'root.isCompactSummary'
  | 'root.promptId'
  | 'root.prompt_id'
  | 'root.turnId'
  | 'root.turn_id'
  | 'root.sessionId'
  | 'root.cwd'
  | 'message.stopReason'
  | 'block.type'
  | 'origin.kind'

export type ScalarKind = 'string' | 'number' | 'boolean' | 'null'

/** One projected piece of a record, in document order. */
export type JsonlEvent =
  | { t: 'beginRecord' }
  | { t: 'promptText'; text: string }
  | { t: 'beginBlock' }
  | { t: 'blockText'; text: string }
  | { t: 'blockEnd' }
  | { t: 'scalar'; slot: ScalarSlot; raw: string; kind: ScalarKind }
  | { t: 'endRecord' }

type Role = 'root' | 'message' | 'content' | 'block' | 'origin' | 'skip'

const ROOT_KEYS: Record<string, ScalarSlot> = {
  type: 'root.type', isMeta: 'root.isMeta', isCompactSummary: 'root.isCompactSummary',
  promptId: 'root.promptId', prompt_id: 'root.prompt_id', turnId: 'root.turnId', turn_id: 'root.turn_id',
  sessionId: 'root.sessionId', cwd: 'root.cwd'
}
const ROOT_FIELDS = new Set([...Object.keys(ROOT_KEYS), 'message', 'origin'])
const MESSAGE_FIELDS = new Set(['content', 'stop_reason'])
const BLOCK_FIELDS = new Set(['type', 'text'])
const ORIGIN_FIELDS = new Set(['kind'])
const NO_FIELDS = new Set<string>()

/** Longest known field name; a longer key cannot match and stops being collected. */
const LONGEST_FIELD = 16
/** A projected scalar is a structural field of the Provider's record, not a body. */
const MAX_SCALAR_CHARS = 64 * 1024

interface Capture {
  kind: 'prompt' | 'block' | 'scalar'
  slot?: ScalarSlot
  text: string
}

/** Applies one token, keeping only the key path a side chat projects. */
export class ClaudeRecordProjector {
  private readonly roles: Role[] = []
  private readonly events: JsonlEvent[] = []
  private key: string | null = null
  private keyCandidates: Set<string> = NO_FIELDS
  private keyPrefix = ''
  private inKey = false
  private capture?: Capture

  accept(token: Token): JsonlEvent[] {
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
      case 'keyValue': break
      default: break
    }
    return this.events
  }

  private start(kind: 'object' | 'array'): void {
    if (this.roles.length === 0) {
      if (kind !== 'object') throw new JsonlRecordError('原生会话记录不是 JSON 对象')
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
    if (role === 'block') this.events.push({ t: 'blockEnd' })
    this.key = null
    this.capture = undefined
    if (this.roles.length === 0) this.events.push({ t: 'endRecord' })
  }

  private childRole(kind: 'object' | 'array'): Role {
    const parent = this.roles.at(-1)
    if (parent === 'skip' || parent === undefined) return 'skip'
    if (parent === 'root') {
      if (this.key === 'message' && kind === 'object') return 'message'
      if (this.key === 'origin' && kind === 'object') return 'origin'
      return 'skip'
    }
    if (parent === 'message') return this.key === 'content' && kind === 'array' ? 'content' : 'skip'
    if (parent === 'content') return kind === 'object' ? 'block' : 'skip'
    return 'skip'
  }

  private beginKey(): void {
    this.inKey = true
    this.keyPrefix = ''
    this.keyCandidates = this.fieldsOfCurrent()
  }

  private fieldsOfCurrent(): Set<string> {
    const parent = this.roles.at(-1)
    if (parent === 'root') return ROOT_FIELDS
    if (parent === 'message') return MESSAGE_FIELDS
    if (parent === 'block') return BLOCK_FIELDS
    if (parent === 'origin') return ORIGIN_FIELDS
    return NO_FIELDS
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
    if (this.capture.kind === 'scalar') {
      if (this.capture.text.length + text.length > MAX_SCALAR_CHARS) {
        throw new JsonlRecordError('原生会话记录字段值不符合该 Provider 的格式')
      }
      this.capture.text += text
      return
    }
    if (this.capture.kind === 'prompt') this.events.push({ t: 'promptText', text })
    else this.events.push({ t: 'blockText', text })
  }

  private beginValue(kind: 'string' | 'number'): void {
    const parent = this.roles.at(-1)
    if (kind === 'string' && parent === 'root' && this.key === 'message') return
    if (parent === 'skip' || this.key === null) return
    const slot = this.scalarSlot()
    if (slot !== undefined) {
      this.capture = { kind: 'scalar', slot, text: '' }
      return
    }
    if (kind !== 'string') return
    if (parent === 'message' && this.key === 'content') this.capture = { kind: 'prompt', text: '' }
    else if (parent === 'block' && this.key === 'text') this.capture = { kind: 'block', text: '' }
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
      this.events.push({ t: 'scalar', slot: capture.slot, raw: capture.text, kind: 'string' })
    }
  }

  private scalarSlot(): ScalarSlot | undefined {
    const parent = this.roles.at(-1)
    if (parent === 'root' && this.key !== null) return ROOT_KEYS[this.key]
    if (parent === 'message' && this.key === 'stop_reason') return 'message.stopReason'
    if (parent === 'block' && this.key === 'type') return 'block.type'
    if (parent === 'origin' && this.key === 'kind') return 'origin.kind'
    return undefined
  }
}

/** Claude transcript events, in document order. */
export async function* projectTranscript(
  handle: FileHandle,
  size: number,
  evidence: TranscriptReadEvidence
): AsyncGenerator<JsonlEvent> {
  yield* projectJsonlRecords(handle, size, claudeRecords, evidence)
}

/** The projector a plain Claude transcript needs. */
export function claudeRecords(): RecordProjector<JsonlEvent> {
  return new ClaudeRecordProjector()
}
