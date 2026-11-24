import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * One durable input channel per kept-alive Claude session.
 *
 * The SDK only keeps a session alive when `prompt` is an async iterable: with a string it starts a
 * session, answers, and exits. Two turns therefore share one iterator, which means exactly one
 * consumer per turn and a strict handoff — a second `next()` in flight would interleave two turns'
 * messages, so the queue refuses it instead of guessing.
 */
export interface ClaudeInputInbox extends AsyncIterable<SDKUserMessage> {
  push(message: SDKUserMessage): void
  /** Ends the stream and releases a pending read; used on release and on interrupt-before-input. */
  close(): void
  readonly closed: boolean
}

export class ClaudeInputInboxBusyError extends Error {
  constructor() {
    super('claude_session_input_busy')
    this.name = 'ClaudeInputInboxBusyError'
  }
}

export function createClaudeInputInbox(): ClaudeInputInbox {
  const queue: SDKUserMessage[] = []
  let readPending: (() => void) | undefined
  let closed = false
  let reading = false

  const wake = (): void => {
    const pending = readPending
    readPending = undefined
    pending?.()
  }

  return {
    get closed() { return closed },
    push(message) {
      if (closed) return
      queue.push(message)
      wake()
    },
    close() {
      if (closed) return
      closed = true
      queue.length = 0
      wake()
    },
    async *[Symbol.asyncIterator]() {
      if (reading) throw new ClaudeInputInboxBusyError()
      reading = true
      try {
        while (!closed) {
          const next = queue.shift()
          if (next) { yield next; continue }
          await new Promise<void>((resolve) => { readPending = resolve })
        }
      } finally {
        reading = false
      }
    }
  }
}
