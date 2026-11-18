// A bounded working set of warm Provider processes, keyed by everything that
// changes what a read would answer: Provider, profile, workspace and executable.
//
// A parked process is only ever reused for a read that starts from the same
// environment and still reports itself reusable; anything else is closed first.
// Nothing is answered from the parked process's earlier result - every read
// still sends the same live queries, so a warm entry saves startup cost only.
export interface WarmPoolScope {
  profileId: string
  cwd: string
}

export interface WarmPoolOptions<V> {
  limit: number
  idleMs: number
  close(value: V): Promise<void> | void
  // Whether the parked value can serve another read at all (e.g. a Provider
  // process that did not fail or start closing).
  reusable(value: V): boolean
  // Environment equality decides reuse: a parked process started with different
  // auth, PATH or isolated-home inputs must not answer the next read.
  sameEnvironment(parked: unknown, next: unknown): boolean
  onCloseError?(error: unknown): void
}

interface WarmEntry<V> {
  value: V
  environment: unknown
  scope: WarmPoolScope
  idle: NodeJS.Timeout
}

export interface WarmPoolInvalidation {
  cwd: string
  profileId?: string
}

// Key order must never depend on the caller's property order.
export function providerWarmKey(parts: Readonly<Record<string, string | undefined>>): string {
  return Object.keys(parts).sort().map(name => `${name}=${parts[name] ?? ''}`).join('\u0000')
}

export class ProviderWarmPool<V> {
  readonly #entries = new Map<string, WarmEntry<V>>()
  readonly #options: WarmPoolOptions<V>

  constructor(options: WarmPoolOptions<V>) {
    this.#options = options
  }

  get size(): number {
    return this.#entries.size
  }

  // Takes a parked value out of the pool. A stale entry (failed process, changed
  // environment) is closed here, so the caller starts from a clean process
  // instead of reusing one whose Provider surface just changed.
  async take(key: string, environment: unknown): Promise<V | undefined> {
    const parked = this.#entries.get(key)
    if (!parked) return undefined
    this.#entries.delete(key)
    clearTimeout(parked.idle)
    if (this.#options.reusable(parked.value) && this.#options.sameEnvironment(parked.environment, environment)) {
      return parked.value
    }
    await this.#closeValue(parked.value)
    return undefined
  }

  // Renews a parked value's idle window without starting or querying a Provider.
  // Returns false when the key is not parked, so the caller knows to do real work.
  touch(key: string): boolean {
    const parked = this.#entries.get(key)
    if (!parked) return false
    clearTimeout(parked.idle)
    parked.idle = this.#arm(key, parked.value)
    return true
  }

  park(key: string, value: V, environment: unknown, scope: WarmPoolScope): void {
    const previous = this.#entries.get(key)
    this.#entries.delete(key)
    if (previous) clearTimeout(previous.idle)
    this.#entries.set(key, { value, environment, scope, idle: this.#arm(key, value) })
    while (this.#entries.size > this.#options.limit) {
      const oldest = this.#entries.entries().next().value as [string, WarmEntry<V>] | undefined
      if (!oldest) return
      this.#entries.delete(oldest[0])
      void this.#closeValue(oldest[1].value)
    }
  }

  // Closes only entries whose scope matches. An invalidation for one workspace
  // must not cost every other workspace its warm process.
  async invalidate(match: WarmPoolInvalidation): Promise<void> {
    const matched = [...this.#entries]
      .filter(([, entry]) => entry.scope.cwd === match.cwd && (match.profileId === undefined || entry.scope.profileId === match.profileId))
    await Promise.all(matched.map(async ([key, entry]) => {
      this.#entries.delete(key)
      clearTimeout(entry.idle)
      await this.#closeValue(entry.value)
    }))
  }

  async dispose(): Promise<void> {
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    await Promise.all(entries.map(async (entry) => {
      clearTimeout(entry.idle)
      await this.#closeValue(entry.value)
    }))
  }

  #arm(key: string, value: V): NodeJS.Timeout {
    const idle = setTimeout(() => {
      // Expiry races a concurrent take/park; only the entry still owning the key
      // may close its value, so a renewed entry is never closed by a stale timer.
      const current = this.#entries.get(key)
      if (!current || current.value !== value) return
      this.#entries.delete(key)
      void this.#closeValue(value)
    }, this.#options.idleMs)
    idle.unref()
    return idle
  }

  async #closeValue(value: V): Promise<void> {
    try { await this.#options.close(value) } catch (error) { this.#options.onCloseError?.(error) }
  }
}
