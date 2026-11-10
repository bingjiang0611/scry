// P3f E2: which daemon runs changed, as the App event feed reports it. While the feed is
// live, a run's pump reads (without waiting at the daemon) only when woken, so no run
// holds the shared watch lane for a long poll and one quiet run cannot delay another.
// Without the feed every pump goes back to its own long poll.
//
// Keyed by ledger run id, the id the daemon's ledger and output log use.

export class RunWakes {
  #live = false
  // Woken since the run's last read began. Kept until consumed, so a wake that lands
  // during a read is seen by the wait after it.
  readonly #pending = new Set<string>()
  readonly #waiters = new Map<string, Set<() => void>>()

  get live(): boolean { return this.#live }

  setLive(live: boolean): void {
    if (this.#live === live) return
    this.#live = live
    // Leaving live mode: waiting pumps return now and fall back to long polling.
    if (!live) this.wakeAll()
  }

  wake(runId: string): void {
    this.#pending.add(runId)
    const waiters = this.#waiters.get(runId)
    if (!waiters) return
    this.#waiters.delete(runId)
    for (const resolve of waiters) resolve()
  }

  /** Notices may have been lost: every run re-reads. */
  wakeAll(): void {
    for (const runId of [...this.#waiters.keys()]) this.wake(runId)
  }

  /** A read is starting; what it will see covers every wake before this point. */
  consume(runId: string): void {
    this.#pending.delete(runId)
  }

  /** Until woken, or `timeoutMs` at most. */
  wait(runId: string, timeoutMs: number): Promise<void> {
    if (this.#pending.has(runId)) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(runId) ?? new Set<() => void>()
      const done = (): void => { clearTimeout(timer); waiters.delete(done); if (waiters.size === 0 && this.#waiters.get(runId) === waiters) this.#waiters.delete(runId); resolve() }
      const timer = setTimeout(done, timeoutMs)
      waiters.add(done)
      this.#waiters.set(runId, waiters)
    })
  }
}
