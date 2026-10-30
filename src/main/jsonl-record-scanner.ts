/**
 * Incremental, bounded-memory scanner for a Provider's JSONL transcript.
 *
 * A raw transcript is one JSON record per line, and one record can be hundreds of MiB
 * because it embeds a whole tool result. Splitting the file on newlines would hold that
 * line, and `JSON.parse` would hold it a second time, so this scanner reads the decoded
 * character stream once and reports only the fields a side chat projects. Everything else
 * is validated structurally and dropped without becoming a value or a string.
 *
 * Text is reported as it arrives, so a caller can spool a visible body to disk instead of
 * accumulating it. Because the producer here is synchronous and spooling is not, events
 * are queued per feed and drained by the caller: a 1 MiB read therefore holds at most
 * 1 MiB of pending text, never the whole file or one record.
 *
 * The projection follows the same rules the shared normalizer uses for native history:
 * the record's own `type`, its `isMeta`/`isCompactSummary` flags, the Provider turn id,
 * `message.stop_reason`, `message.content` (string or block array), a block's `type` and
 * `text`, and `origin.kind`. Nothing is inferred from position or from payload text.
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

interface Frame {
  role: Role
  kind: 'object' | 'array'
}

const ROOT_SLOTS: Record<string, ScalarSlot> = {
  type: 'root.type', isMeta: 'root.isMeta', isCompactSummary: 'root.isCompactSummary',
  promptId: 'root.promptId', prompt_id: 'root.prompt_id', turnId: 'root.turnId', turn_id: 'root.turn_id',
  sessionId: 'root.sessionId', cwd: 'root.cwd'
}

/** A record field name is a key, not content: a huge one is not a real transcript. */
const MAX_KEY_CHARS = 4096

export class JsonlRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonlRecordError'
  }
}

export class JsonlRecordScanner {
  private readonly frames: Frame[] = []
  private readonly events: JsonlEvent[] = []
  private key: string | null = null
  private inString = false
  private stringIsKey = false
  private capture: 'prompt' | 'block' | null = null
  /** A projected scalar string being collected; its value is small by contract. */
  private scalarValue?: { slot: ScalarSlot; text: string }
  private escape = 0
  private unicodeDigits = ''
  private keyBuf = ''
  private run = ''
  private primitive = ''
  /** A key was read and its value has not started: a separator here is a corrupt record. */
  private pendingValue = false
  /** A comma was read and no member or element followed: a trailing separator. */
  private afterComma = false
  /** Decoded characters consumed so far, for the caller's prefix evidence. */
  bytes = 0

  /** Feeds one decoded piece of the file and queues everything it completes. */
  feed(text: string): void {
    this.bytes += Buffer.byteLength(text, 'utf8')
    let index = 0
    while (index < text.length) {
      if (this.inString) {
        if (this.escape !== 0) {
          index = this.consumeEscape(text, index)
          continue
        }
        const next = nextSpecial(text, index)
        if (next < 0) {
          this.consumeStringChars(text.slice(index))
          break
        }
        this.consumeStringChars(text.slice(index, next))
        const special = text[next]
        index = next + 1
        if (special === '\\') this.escape = 1
        else this.finishString()
        continue
      }
      const char = text[index]
      index += 1
      this.consumeStructural(char)
    }
    this.flushRun()
  }

  /** Queued events, in document order. The caller must drain after every `feed`. */
  drain(): JsonlEvent[] {
    return this.events.splice(0)
  }

  /** The trailing bytes were an unfinished record: not evidence, and never projected. */
  end(): void {
    this.flushRun()
  }

  private consumeStructural(char: string): void {
    if (char === '\n' || char === '\r' || char === '\t' || char === ' ') {
      // A newline inside an open record means the writer emitted invalid JSON, not that
      // the tail is still being appended: a truncated tail has no following newline.
      if (char === '\n' && this.frames.length > 0) {
        throw new JsonlRecordError('原生会话记录在未闭合时换行，无法确认前缀内容')
      }
      return
    }
    if (this.primitive !== '') {
      if (isPrimitiveEnd(char)) {
        this.finishPrimitive()
        this.consumeStructural(char)
        return
      }
      this.primitive += char
      return
    }
    switch (char) {
      case '{': this.openContainer('object'); return
      case '[': this.openContainer('array'); return
      case '}': this.trailingSeparator(); this.missingValue(); this.closeContainer('object'); return
      case ']': this.trailingSeparator(); this.missingValue(); this.closeContainer('array'); return
      case ',': this.missingValue(); this.afterComma = true; this.key = null; return
      case ':': this.pendingValue = true; return
      case '"': this.startString(); return
      default:
        if (char === '-' || (char >= '0' && char <= '9') || (char >= 'a' && char <= 'z')) {
          if (this.frames.length === 0) throw new JsonlRecordError('原生会话记录不是 JSON 对象')
          this.pendingValue = false
          this.afterComma = false
          this.primitive = char
          return
        }
        throw new JsonlRecordError(`原生会话记录出现无法解析的字符 ${JSON.stringify(char)}`)
    }
  }

  private missingValue(): void {
    if (!this.pendingValue) return
    throw new JsonlRecordError('原生会话记录缺少字段值')
  }

  private trailingSeparator(): void {
    if (!this.afterComma) return
    throw new JsonlRecordError('原生会话记录包含多余的分隔符')
  }

  private openContainer(kind: 'object' | 'array'): void {
    this.pendingValue = false
    this.afterComma = false
    if (this.frames.length === 0) {
      if (kind !== 'object') throw new JsonlRecordError('原生会话记录不是 JSON 对象')
      this.events.push({ t: 'beginRecord' })
      this.frames.push({ role: 'root', kind })
      this.key = null
      return
    }
    const role = this.childRole()
    if (kind === 'object' && role === 'block') this.events.push({ t: 'beginBlock' })
    this.frames.push({ role, kind })
    this.key = null
  }

  private closeContainer(kind: 'object' | 'array'): void {
    const frame = this.frames.at(-1)
    if (!frame || frame.kind !== kind) throw new JsonlRecordError('原生会话记录结构不完整')
    if (frame.role === 'block') this.events.push({ t: 'blockEnd' })
    this.frames.pop()
    this.key = null
    if (this.frames.length === 0) this.events.push({ t: 'endRecord' })
  }

  private startString(): void {
    this.pendingValue = false
    this.afterComma = false
    const frame = this.frames.at(-1)
    if (!frame) throw new JsonlRecordError('原生会话记录不是 JSON 对象')
    this.inString = true
    // A key is the string that opens an object member: that member has no key yet.
    this.stringIsKey = frame.kind === 'object' && this.key === null
    if (this.stringIsKey) {
      this.keyBuf = ''
      return
    }
    const slot = this.scalarSlot()
    if (slot !== undefined) {
      this.scalarValue = { slot, text: '' }
      return
    }
    this.capture = this.stringCapture()
  }

  private stringCapture(): 'prompt' | 'block' | null {
    const frame = this.frames.at(-1)
    if (!frame || frame.role === 'skip') return null
    if (frame.kind === 'array') return frame.role === 'content' ? 'block' : null
    if (frame.role === 'block' && this.key === 'text') return 'block'
    if (frame.role === 'message' && this.key === 'content') return 'prompt'
    return null
  }

  private childRole(): Role {
    const frame = this.frames.at(-1)
    if (!frame) return 'root'
    if (frame.role === 'skip') return 'skip'
    if (frame.kind === 'array') return frame.role === 'content' ? 'block' : 'skip'
    switch (frame.role) {
      case 'root':
        if (this.key === 'message') return 'message'
        if (this.key === 'origin') return 'origin'
        return 'skip'
      case 'message':
        return this.key === 'content' ? 'content' : 'skip'
      default:
        return 'skip'
    }
  }

  private consumeStringChars(text: string): void {
    if (text.length === 0) return
    for (let index = 0; index < text.length; index += 1) {
      // A raw control character is invalid JSON and would make the prefix unverifiable.
      if (text.charCodeAt(index) < 0x20) throw new JsonlRecordError('原生会话记录字符串包含未转义的控制字符')
    }
    if (this.stringIsKey) {
      this.keyBuf += text
      if (this.keyBuf.length > MAX_KEY_CHARS) throw new JsonlRecordError('原生会话记录字段名过长')
      return
    }
    if (this.scalarValue) {
      this.scalarValue.text += text
      if (this.scalarValue.text.length > MAX_KEY_CHARS) throw new JsonlRecordError('原生会话记录字段值过长')
      return
    }
    if (this.capture !== null) this.run += text
  }

  /** Continues an escape sequence; returns the next unconsumed character index. */
  private consumeEscape(text: string, index: number): number {
    const char = text[index]
    if (char === undefined) return index
    if (this.escape === 1) {
      this.escape = 0
      switch (char) {
        case '"': case '\\': case '/': this.emitEscaped(char); return index + 1
        case 'b': this.emitEscaped('\b'); return index + 1
        case 'f': this.emitEscaped('\f'); return index + 1
        case 'n': this.emitEscaped('\n'); return index + 1
        case 'r': this.emitEscaped('\r'); return index + 1
        case 't': this.emitEscaped('\t'); return index + 1
        case 'u': this.escape = 2; this.unicodeDigits = ''; return index + 1
        default: throw new JsonlRecordError('原生会话记录包含无效的字符串转义')
      }
    }
    this.unicodeDigits += char
    if (this.unicodeDigits.length < 4) return index + 1
    if (!/^[0-9a-fA-F]{4}$/.test(this.unicodeDigits)) throw new JsonlRecordError('原生会话记录包含无效的 \\u 转义')
    this.escape = 0
    // Code units are emitted exactly as written; the spool pairs a split surrogate pair.
    this.emitEscaped(String.fromCharCode(parseInt(this.unicodeDigits, 16)))
    return index + 1
  }

  private emitEscaped(char: string): void {
    if (this.stringIsKey) {
      this.keyBuf += char
      if (this.keyBuf.length > MAX_KEY_CHARS) throw new JsonlRecordError('原生会话记录字段名过长')
      return
    }
    if (this.scalarValue) {
      this.scalarValue.text += char
      return
    }
    if (this.capture !== null) this.run += char
  }

  private finishString(): void {
    this.inString = false
    if (this.stringIsKey) {
      this.key = this.keyBuf
      this.keyBuf = ''
      this.stringIsKey = false
      return
    }
    this.flushRun()
    const scalar = this.scalarValue
    this.scalarValue = undefined
    this.capture = null
    if (scalar) this.events.push({ t: 'scalar', slot: scalar.slot, raw: scalar.text, kind: 'string' })
    // The member is complete; the object is ready for its next key.
    this.key = null
  }

  private finishPrimitive(): void {
    const raw = this.primitive
    this.primitive = ''
    const slot = this.scalarSlot()
    this.key = null
    // Validate even a dropped literal so a corrupt record cannot pass as a value.
    if (!/^(true|false|null)$/.test(raw) && !NUMBER.test(raw)) throw new JsonlRecordError('原生会话记录包含无效的字面量')
    if (slot === undefined) return
    if (raw === 'true' || raw === 'false') this.events.push({ t: 'scalar', slot, raw, kind: 'boolean' })
    else if (raw === 'null') this.events.push({ t: 'scalar', slot, raw, kind: 'null' })
    else this.events.push({ t: 'scalar', slot, raw, kind: 'number' })
  }

  private scalarSlot(): ScalarSlot | undefined {
    const frame = this.frames.at(-1)
    if (!frame || frame.role === 'skip' || frame.kind !== 'object' || this.key === null) return undefined
    if (frame.role === 'root') return ROOT_SLOTS[this.key]
    if (frame.role === 'message' && this.key === 'stop_reason') return 'message.stopReason'
    if (frame.role === 'block' && this.key === 'type') return 'block.type'
    if (frame.role === 'origin' && this.key === 'kind') return 'origin.kind'
    return undefined
  }

  private flushRun(): void {
    const chunk = this.run
    this.run = ''
    if (chunk.length === 0) return
    if (this.capture === 'prompt') this.events.push({ t: 'promptText', text: chunk })
    else if (this.capture === 'block') this.events.push({ t: 'blockText', text: chunk })
  }
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/

/** Next `"` or `\` at or after `index`; the two characters that end a plain run. */
function nextSpecial(text: string, index: number): number {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text.charCodeAt(cursor)
    if (char === 0x22 || char === 0x5c) return cursor
  }
  return -1
}

function isPrimitiveEnd(char: string): boolean {
  return char === ',' || char === '}' || char === ']' || char === '\n' || char === '\r' ||
    char === '\t' || char === ' '
}
