// P3f E3: runs this window did not start appear without the renderer asking. In process,
// a phone's run reaches the window because every run's trace does; in daemon mode the
// window only hears runs it follows. A run notice for an unknown run triggers one look
// at the daemon's live list (the same authority agent:activeRuns uses), and every live
// run nobody here follows is followed from where its evidence starts.

export interface DaemonRunDiscoveryDeps {
  liveRuns(): Promise<{ runs: ReadonlyArray<{ runId: string }> }>
  isTracking(runId: string): boolean
  follow(input: { runId: string; seq?: number }): Promise<unknown>
  onWarn?: (message: string, detail?: unknown) => void
}

// Notices only hint where a run starts; a burst beyond this is still discovered, just
// from the newest position this connection has seen.
const MAX_HINTS = 256

export class DaemonRunDiscovery {
  readonly #deps: DaemonRunDiscoveryDeps
  #hints = new Map<string, number | undefined>()
  #checking = false
  #again = false

  constructor(deps: DaemonRunDiscoveryDeps) {
    this.#deps = deps
  }

  notice(runId: string, intentSeq?: number): void {
    if (this.#deps.isTracking(runId)) return
    if (this.#hints.has(runId) || this.#hints.size < MAX_HINTS) this.#hints.set(runId, intentSeq)
    void this.#check()
  }

  /** Notices may have been lost: look at the live list without one. */
  resynchronize(): void {
    void this.#check()
  }

  // One look at a time: notices that arrive while it is out are answered by one more.
  async #check(): Promise<void> {
    if (this.#checking) { this.#again = true; return }
    this.#checking = true
    try {
      do {
        this.#again = false
        const hints = this.#hints
        this.#hints = new Map()
        let live: Awaited<ReturnType<DaemonRunDiscoveryDeps['liveRuns']>>
        try {
          live = await this.#deps.liveRuns()
        } catch (error) {
          this.#deps.onWarn?.('daemon run discovery failed', error)
          return
        }
        for (const { runId } of live.runs) {
          if (this.#deps.isTracking(runId)) continue
          const seq = hints.get(runId)
          void this.#deps.follow({ runId, ...(seq !== undefined ? { seq } : {}) })
            .catch((error) => this.#deps.onWarn?.('daemon run follow failed', error))
        }
      } while (this.#again)
    } finally {
      this.#checking = false
    }
  }
}
