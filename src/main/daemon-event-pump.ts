import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { HostAdminNotice } from '../shared/host-admin'
import type { SubscribeEventItem, SubscribeHint, SubscribeSnapshot } from '../shared/orchestration-subscribe'
import { runSubscribeLoop, type SubscribePumpDeps } from './daemon-event-pump-subscribe'

export interface DaemonEventPumpDeps {
  source: Pick<SubscribePumpDeps, 'subscribe'>
  send: (channel: string, payload: unknown) => void
  detailFocus?: SubscribePumpDeps['detailFocus']
  waitMs?: number
  retry?: { initialMs: number; maxMs: number }
  sleep?: (ms: number) => Promise<void>
  onWarn?: (message: string, detail?: unknown) => void
  onSnapshot?: (snapshot: SubscribeSnapshot, meta: { isReset: boolean; logIdChanged: boolean }) => Promise<void> | void
  onSubscribeEvent?: (event: SubscribeEventItem) => Promise<void> | void
  onRunHint?: (hint: Extract<SubscribeHint, { kind: 'run' }>) => void
  onLogIdChanged?: (prevLogId: string, nextLogId: string) => void
  // Notices may have been lost; every run re-reads.
  onResync?: () => void
  // E1b: the daemon's whole unread set.
  onAttention?: (snapshot: SessionAttentionSnapshot) => void
  // Terminal output is waiting (P3-terminal.md); read it by cursor.
  onTerminal?: () => void
  // An MCP OAuth page the daemon asks this App to open (its own re-auth only).
  onOAuth?: (url: string) => void
  onHostAdmin?: (notice: HostAdminNotice) => void
  // W1: one of the run pipeline's window notices. Awaited, so notices keep their order;
  // without a handler it goes to the window as it came.
  onWindow?: (channel: string, payload: Record<string, unknown>) => Promise<void> | void
}

const DEFAULT_WAIT_MS = 20_000
const DEFAULT_RETRY = { initialMs: 1_000, maxMs: 30_000 }

export class DaemonEventPump {
  readonly #deps: DaemonEventPumpDeps
  readonly #abort = new AbortController()
  #running = false

  constructor(deps: DaemonEventPumpDeps) {
    this.#deps = deps
  }

  start(): void {
    if (this.#running || this.#abort.signal.aborted) return
    this.#running = true
    void this.#loop()
  }

  dispose(): void {
    this.#abort.abort()
  }

  async #loop(): Promise<void> {
    const { source, send } = this.#deps
    const retry = this.#deps.retry ?? DEFAULT_RETRY
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    try {
      await runSubscribeLoop({
        ...this.#deps,
        subscribe: (input, signal) => source.subscribe(input, signal),
        send,
        waitMs: this.#deps.waitMs ?? DEFAULT_WAIT_MS,
        retry,
        sleep,
        signal: this.#abort.signal
      })
    } finally {
      this.#running = false
    }
  }
}
