import type { Query } from '@qoder-ai/qoder-agent-sdk'

/**
 * C1: one kept Qoder SDK query serves several turns.
 *
 * The SDK keeps a session alive only while `prompt` is an async iterable, and its message iterator can
 * be consumed once. A session therefore owns that single reader and routes each message to the turn
 * that is currently waiting for it. A turn ends when the run decides it has settled (a root result with
 * no background work left); the session stays open so the next turn reuses the CLI and its MCP servers.
 */
export interface QoderTurnChannel extends AsyncIterable<Record<string, unknown>> {
  /** The turn stopped waiting; later messages belong to no turn until the next one starts. */
  end(): void
  readonly ended: boolean
  /** Messages that arrived while no turn was waiting are handed to the next turn in order. */
  readonly pending: number
}

export interface QoderSession {
  beginTurn(): QoderTurnChannel
  /** The live query, for interrupt/model/permission control while a turn runs. */
  readonly query: Query
  close(): Promise<void>
  readonly closed: boolean
}

export class QoderSessionBusyError extends Error {
  constructor() {
    super('qoder_session_turn_busy')
    this.name = 'QoderSessionBusyError'
  }
}

/**
 * `pump` reads the SDK iterator once for the session's whole life. A session that cannot start one is
 * still a session — it fails every waiting turn instead of hanging them.
 */
export function createQoderSession(query: Query): QoderSession {
  const backlog: Record<string, unknown>[] = []
  let active: {
    queue: Record<string, unknown>[]
    wake: (() => void) | undefined
    ended: boolean
    reading: boolean
  } | undefined
  let closed = false
  let failure: Error | undefined

  const deliver = (message: Record<string, unknown>): void => {
    const turn = active
    if (!turn) {
      backlog.push(message)
      return
    }
    turn.queue.push(message)
    const wake = turn.wake
    turn.wake = undefined
    wake?.()
  }

  const pump = (async () => {
    try {
      for await (const message of query) {
        deliver(message as unknown as Record<string, unknown>)
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    } finally {
      closed = true
      const wake = active?.wake
      active && (active.wake = undefined)
      wake?.()
    }
  })()

  return {
    get query() { return query },
    get closed() { return closed },
    beginTurn() {
      if (active && !active.ended) throw new QoderSessionBusyError()
      const turn = { queue: backlog.splice(0, backlog.length), wake: undefined as (() => void) | undefined, ended: false, reading: false }
      active = turn
      return {
        get ended() { return turn.ended },
        get pending() { return turn.queue.length },
        end() {
          turn.ended = true
          turn.queue.length = 0
          if (active === turn) active = undefined
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void> {
          if (turn.reading) throw new QoderSessionBusyError()
          turn.reading = true
          try {
            for (;;) {
              const next = turn.queue.shift()
              if (next) {
                yield next
                continue
              }
              if (turn.ended) return
              if (failure) throw failure
              if (closed) return
              await new Promise<void>((resolve) => { turn.wake = resolve })
            }
          } finally {
            turn.reading = false
          }
        }
      } satisfies QoderTurnChannel
    },
    async close() {
      if (!closed) {
        try { await query.close?.() } catch { /* close errors surface through the turn */ }
      }
      closed = true
      await pump
    }
  }
}
