import type { AgentDataUpdated } from '../shared/runtime'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import { DaemonRunError } from './daemon-run-transport'

// P3f: the App side of the daemon's event feed. One long poll per daemon connection, on
// its own lane; every notice reaches the window exactly as the in-process App sent it.
// Lost notices are never papered over: a reset, or a poll that failed and may have
// missed some, tells every view to re-read what it shows.

export interface DaemonEventReply {
  epoch: string
  cursor: number
  items: Array<{ kind: 'data'; event: AgentDataUpdated } | { kind: 'run'; runId: string } | { kind: 'attention'; snapshot: SessionAttentionSnapshot }>
  reset: boolean
}

export interface DaemonEventSource {
  appEvents(input: { epoch?: string; cursor: number; waitMs: number }, signal?: AbortSignal): Promise<DaemonEventReply>
}

export interface DaemonEventPumpDeps {
  source: DaemonEventSource
  send: (channel: string, payload: unknown) => void
  waitMs?: number
  retry?: { initialMs: number; maxMs: number }
  sleep?: (ms: number) => Promise<void>
  onWarn?: (message: string, detail?: unknown) => void
  // E2: a ledger run changed; read it.
  onRun?: (runId: string) => void
  // Notices may have been lost; every run re-reads.
  onResync?: () => void
  // Whether runs can rely on wakes, or must long-poll on their own.
  onLive?: (live: boolean) => void
  // E1b: the daemon's whole unread set.
  onAttention?: (snapshot: SessionAttentionSnapshot) => void
}

const DEFAULT_WAIT_MS = 20_000
const DEFAULT_RETRY = { initialMs: 1_000, maxMs: 30_000 }
const RESYNCHRONIZE: AgentDataUpdated = { kind: 'resynchronize' }

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
    let epoch: string | undefined
    let cursor = 0
    let pause = retry.initialMs
    let missed = false
    try {
      while (!this.#abort.signal.aborted) {
        let reply: DaemonEventReply
        try {
          reply = await source.appEvents({ ...(epoch !== undefined ? { epoch } : {}), cursor, waitMs: this.#deps.waitMs ?? DEFAULT_WAIT_MS }, this.#abort.signal)
        } catch (error) {
          if (this.#abort.signal.aborted) return
          // An older daemon has no feed: a named absence, not something to poll for.
          if (error instanceof DaemonRunError && error.reason === 'daemon_run_control_unavailable') {
            this.#deps.onWarn?.('daemon event feed unavailable', error)
            this.#setLive(false)
            return
          }
          this.#setLive(false)
          // A notice may have been in that reply; the views re-read once it is back.
          if (epoch !== undefined) missed = true
          await sleep(pause)
          pause = Math.min(pause * 2, retry.maxMs)
          continue
        }
        if (this.#abort.signal.aborted) return
        pause = retry.initialMs
        this.#setLive(true)
        if (reply.reset || missed) {
          send('agent:dataUpdated', RESYNCHRONIZE)
          this.#deps.onResync?.()
        }
        missed = false
        for (const item of reply.items) {
          if (item.kind === 'data') send('agent:dataUpdated', item.event)
          else if (item.kind === 'run') this.#deps.onRun?.(item.runId)
          else this.#deps.onAttention?.(item.snapshot)
        }
        epoch = reply.epoch
        cursor = reply.cursor
      }
    } finally {
      this.#running = false
      this.#setLive(false)
    }
  }

  #live = false
  #setLive(live: boolean): void {
    if (this.#live === live) return
    this.#live = live
    this.#deps.onLive?.(live)
  }
}
