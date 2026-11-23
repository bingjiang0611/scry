// Wakes admission waits when a subscription updates the corresponding run.

export class RunWakes {
  // Woken since the run's last read began. Kept until consumed, so a wake that lands
  // during a read is seen by the wait after it.
  readonly #pending = new Set<string>()
  readonly #waiters = new Map<string, Set<() => void>>()

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
