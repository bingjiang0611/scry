export class RunWakes {
  readonly #pending = new Set<string>()
  readonly #waiters = new Map<string, Set<() => void>>()

  wake(runId: string): void {
    this.#pending.add(runId)
    const waiters = this.#waiters.get(runId)
    if (!waiters) return
    this.#waiters.delete(runId)
    for (const resolve of waiters) resolve()
  }

  wakeAll(): void {
    for (const runId of [...this.#waiters.keys()]) this.wake(runId)
  }

  consume(runId: string): void {
    this.#pending.delete(runId)
  }

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
