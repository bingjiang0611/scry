/**
 * Chunk-stream text normalization for exact hashing and byte counting.
 *
 * A producer may split a surrogate pair across two chunks (the archive parser, a paged
 * read, a paged body). Hashing or counting each half on its own encodes it as U+FFFD, so
 * the digest and byte total no longer match the UTF-8 of the whole message even though
 * the concatenated text is correct. This defers a trailing high surrogate until the next
 * chunk, so every emitted piece ends on a whole code point. The carry is one code unit.
 *
 * A genuinely lone surrogate (nothing follows it before sealing) is flushed unchanged and
 * then encodes as JavaScript does, so the digest still matches the original text.
 */
export class Utf8ChunkNormalizer {
  private carry = ''

  push(chunk: string): string {
    if (chunk.length === 0) return ''
    const text = this.carry + chunk
    this.carry = ''
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      this.carry = text.slice(-1)
      return text.slice(0, -1)
    }
    return text
  }

  /** Emits the deferred code unit, if any; call exactly once, before the final hash. */
  flush(): string {
    const tail = this.carry
    this.carry = ''
    return tail
  }

  /** The deferred unit without consuming it, for sizes read before the content is sealed. */
  pending(): string {
    return this.carry
  }
}
