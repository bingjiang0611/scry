/**
 * One durable input channel per kept-alive Provider session.
 *
 * The Claude and Qoder SDKs only keep a session alive when `prompt` is an async iterable: with a
 * string they start a session, answer, and exit. Two turns therefore share one iterator, which means
 * exactly one consumer per turn and a strict handoff — a second `next()` in flight would interleave
 * two turns' messages, so the queue refuses it instead of guessing.
 */
export interface ProviderInputInbox<TMessage> extends AsyncIterable<TMessage> {
  push(message: TMessage): void
  /** Ends the stream and releases a pending read; used on release and on interrupt-before-input. */
  close(): void
  readonly closed: boolean
}

export class ProviderInputInboxBusyError extends Error {
  constructor() {
    super('provider_session_input_busy')
    this.name = 'ProviderInputInboxBusyError'
  }
}

export function createProviderInputInbox<TMessage>(): ProviderInputInbox<TMessage> {
  const queue: TMessage[] = []
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
      if (reading) throw new ProviderInputInboxBusyError()
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
