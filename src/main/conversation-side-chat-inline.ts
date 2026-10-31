import { historyTextFor } from './conversation-history'
import { historicalInputBytes } from './providers/historical-input'

/**
 * Exact bytes one frozen message costs in the first-send handoff, computed while the
 * text is still a stream.
 *
 * The handoff embeds the frozen manifest as JSON, then embeds that JSON again inside a
 * labelled prompt, so a quote costs four bytes and a newline eight. Both escapes are
 * additive per character, so the total is a per-list constant, one constant per message,
 * and the double-escaped size of that message's text. Nothing here joins the text.
 */

/** JSON string escaping, counted per character, with no allocated result. */
function escapeBytes(text: string): number {
  return JSON.stringify(text).length - 2
}

/** Bytes the handoff adds around the whole message list, counted from the real functions. */
export function handoffWrapBytes(coverage: string): number {
  return historicalInputBytes(historyTextFor([], coverage))
}

/** Constant bytes around one message inside the list, without its text. */
export function messageBaseBytes(fields: Record<string, unknown>): number {
  const empty = JSON.stringify({ ...fields, text: '' })
  return escapeBytes(empty.slice(0, -1)) + escapeBytes('"}')
}

/** Cost of the list separators between messages. */
export const separatorBytes = (): number => escapeBytes(',')

/**
 * Double-escaped byte count of a text stream.
 *
 * A trailing high surrogate is held back so a chunk boundary between the two halves of
 * one character cannot change the count; the character is measured once it is complete.
 */
export class HandoffTextBytes {
  private held = ''
  private bytes = 0

  add(chunk: string): void {
    let text = this.held + chunk
    this.held = ''
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      this.held = text.slice(-1)
      text = text.slice(0, -1)
    }
    if (text.length > 0) this.bytes += escapeBytes(JSON.stringify(text).slice(1, -1))
  }

  total(): number {
    if (this.held.length > 0) this.bytes += escapeBytes(JSON.stringify(this.held).slice(1, -1))
    this.held = ''
    return this.bytes
  }
}
