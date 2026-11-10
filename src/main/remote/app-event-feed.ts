import { randomUUID } from 'node:crypto'
import type { AgentDataUpdated } from '../../shared/runtime'
import type { SessionAttentionSnapshot } from '../../shared/session-attention'

// P3f: what the daemon tells its own App that no run read carries. Notices only, never
// bodies: the App re-reads through the authorized readers it already uses. Bounded and
// in memory; a daemon restart or a range that fell out of the buffer answers `reset`,
// so a client resynchronizes instead of silently missing a change (t3code's
// replay-or-snapshot rule, on the App's existing long-poll lanes).

export type AppEvent =
  | { kind: 'data'; event: AgentDataUpdated }
  // A ledger run's events or output changed (E2); the App reads that run, nothing else.
  | { kind: 'run'; runId: string; intentSeq?: number }
  // The daemon's whole unread set (E1b): state, so only the newest one matters.
  | { kind: 'attention'; snapshot: SessionAttentionSnapshot }

export interface AppEventsReply {
  epoch: string
  cursor: number
  items: AppEvent[]
  /** Events after the cursor were lost: re-read what you show. */
  reset?: true
}

export const APP_EVENTS_MAX_WAIT_MS = 25_000
const DEFAULT_MAX_ITEMS = 512
const DEFAULT_MAX_BYTES = 256 * 1024

interface Entry { seq: number; event: AppEvent; key?: string; bytes: number }

// One notice per subject is enough: a newer one says everything an older one did.
function coalesceKey(event: AppEvent): string | undefined {
  if (event.kind === 'run') return `run:${event.runId}`
  if (event.kind === 'attention') return 'attention'
  const data = event.event
  if ('kind' in data && data.kind === 'conversation_changed') return `conversation:${data.conversationId}`
  if ('kind' in data && data.kind === 'catalog_recovered') return 'catalog'
  return undefined
}

export class AppEventFeed {
  readonly epoch: string
  readonly #maxItems: number
  readonly #maxBytes: number
  #entries: Entry[] = []
  #bytes = 0
  #seq = 0
  // Highest sequence dropped for capacity. A coalesced entry is not a loss: a newer one
  // with the same subject stands in for it.
  #lost = 0
  #waiters = new Set<() => void>()
  #closed = false
  // State a client cannot rebuild from changes it never saw (the unread set): handed to
  // a new client and to one told to resynchronize, instead of replaying history.
  readonly #state: () => AppEvent[]

  constructor(options: { epoch?: string; maxItems?: number; maxBytes?: number; state?: () => AppEvent[] } = {}) {
    this.epoch = options.epoch ?? randomUUID()
    this.#state = options.state ?? (() => [])
    this.#maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  append(event: AppEvent): void {
    if (this.#closed) return
    const key = coalesceKey(event)
    if (key !== undefined) {
      const index = this.#entries.findIndex((entry) => entry.key === key)
      if (index >= 0) this.#bytes -= this.#entries.splice(index, 1)[0]!.bytes
    }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.#entries.push({ seq: ++this.#seq, event, ...(key !== undefined ? { key } : {}), bytes })
    this.#bytes += bytes
    while (this.#entries.length > this.#maxItems || (this.#bytes > this.#maxBytes && this.#entries.length > 1)) {
      const dropped = this.#entries.shift()!
      this.#bytes -= dropped.bytes
      this.#lost = dropped.seq
    }
    this.#wake()
  }

  async read(input: { epoch?: string; cursor: number; waitMs: number }): Promise<AppEventsReply> {
    // A client without an epoch is new: it reads current state itself, so it starts here.
    if (input.epoch === undefined) return { epoch: this.epoch, cursor: this.#seq, items: this.#state() }
    if (input.epoch !== this.epoch || input.cursor > this.#seq || input.cursor < this.#lost) {
      return { epoch: this.epoch, cursor: this.#seq, items: this.#state(), reset: true }
    }
    const pending = this.#after(input.cursor)
    if (pending.length > 0 || this.#closed || input.waitMs <= 0) return { epoch: this.epoch, cursor: this.#seq, items: pending }
    await this.#waitForChange(Math.min(input.waitMs, APP_EVENTS_MAX_WAIT_MS))
    return await this.read({ ...input, waitMs: 0 })
  }

  close(): void {
    this.#closed = true
    this.#wake()
  }

  #after(cursor: number): AppEvent[] {
    return this.#entries.filter((entry) => entry.seq > cursor).map((entry) => entry.event)
  }

  #wake(): void {
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    for (const wake of waiters) wake()
  }

  #waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => { clearTimeout(timer); this.#waiters.delete(wake); resolve() }
      const timer = setTimeout(wake, timeoutMs)
      this.#waiters.add(wake)
    })
  }
}
