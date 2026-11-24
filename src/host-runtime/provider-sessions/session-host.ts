export type ProviderSessionReleaseReason =
  | 'idle'
  | 'evicted'
  | 'replaced'
  | 'error'
  | 'shutdown'
  | 'background_expired'

export interface ProviderSessionHostOptions {
  /** Idle release window. C1 default is 20 minutes (allowed range 15–30). */
  idleMs?: number
  /** A session with background tasks keeps its process at most this long. */
  maxBackgroundHoldMs?: number
  /** Global cap; the least recently used idle session is evicted first. */
  maxSessions?: number
  now?: () => number
  onReleased?: (key: string, reason: ProviderSessionReleaseReason) => void
}

interface Entry<T> {
  key: string
  value: T
  sessionId: string
  busy: boolean
  backgroundTasks: number
  openedAt: number
  lastUsedAt: number
  backgroundSince?: number
  idleTimer?: ReturnType<typeof setTimeout>
  close: () => Promise<void> | void
}

export class ProviderSessionCapExceededError extends Error {
  constructor() {
    super('provider_session_cap_exceeded')
    this.name = 'ProviderSessionCapExceededError'
  }
}

const DEFAULT_IDLE_MS = 20 * 60_000
const DEFAULT_MAX_BACKGROUND_HOLD_MS = 4 * 3_600_000
const DEFAULT_MAX_SESSIONS = 8

/**
 * C1: the daemon's Provider session lifetime. One run is one turn on a session, so a session is
 * reused while its key matches, released when idle, kept while background tasks run (bounded by
 * four hours), and evicted idle-first when the global cap is reached.
 */
export class ProviderSessionHost<T> {
  readonly #entries = new Map<string, Entry<T>>()
  readonly #idleMs: number
  readonly #maxBackgroundHoldMs: number
  readonly #maxSessions: number
  readonly #now: () => number
  readonly #onReleased?: (key: string, reason: ProviderSessionReleaseReason) => void

  constructor(options: ProviderSessionHostOptions = {}) {
    this.#idleMs = Math.min(30 * 60_000, Math.max(15 * 60_000, options.idleMs ?? DEFAULT_IDLE_MS))
    this.#maxBackgroundHoldMs = options.maxBackgroundHoldMs ?? DEFAULT_MAX_BACKGROUND_HOLD_MS
    this.#maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS)
    this.#now = options.now ?? Date.now
    this.#onReleased = options.onReleased
  }

  get size(): number {
    return this.#entries.size
  }

  /** Reuses a live session for `key`, or opens one. Concurrent acquire for one key is serialized. */
  async acquire(
    key: string,
    open: () => Promise<{ value: T; sessionId: string; close: () => Promise<void> | void; closed?: boolean }>,
    isClosed?: (entry: { value: T; sessionId: string }) => boolean
  ): Promise<{ value: T; sessionId: string; reused: boolean }> {
    const existing = this.#entries.get(key)
    if (existing) {
      if (existing.busy || (isClosed?.(existing) ?? false)) {
        await this.release(key, isClosed?.(existing) ? 'error' : 'replaced')
      } else {
        existing.busy = true
        existing.lastUsedAt = this.#now()
        this.#clearIdle(existing)
        return { value: existing.value, sessionId: existing.sessionId, reused: true }
      }
    }
    await this.#makeRoom()
    const opened = await open()
    const entry: Entry<T> = {
      key,
      value: opened.value,
      sessionId: opened.sessionId,
      busy: true,
      backgroundTasks: 0,
      openedAt: this.#now(),
      lastUsedAt: this.#now(),
      close: opened.close
    }
    this.#entries.set(key, entry)
    return { value: entry.value, sessionId: entry.sessionId, reused: false }
  }

  /**
   * Registers a second key for a live session. A turn that opened a fresh native session is later
   * resumed by that native id, which derives a different key; the alias makes the second turn reuse
   * the process it already owns instead of spawning another one.
   */
  alias(fromKey: string, toKey: string): boolean {
    const entry = this.#entries.get(fromKey)
    if (!entry || fromKey === toKey) return false
    this.#entries.set(toKey, entry)
    return true
  }

  /** Marks the turn finished. `reusable: false` releases the process immediately. */
  async settle(key: string, options: { reusable: boolean; keepForBackground?: boolean }): Promise<void> {
    const entry = this.#entries.get(key)
    if (!entry) return
    entry.busy = false
    entry.lastUsedAt = this.#now()
    if (options.keepForBackground) {
      entry.backgroundTasks = Math.max(1, entry.backgroundTasks)
      entry.backgroundSince ??= this.#now()
    }
    if (!options.reusable) {
      await this.release(key, 'error')
      return
    }
    this.#scheduleIdle(entry)
  }

  noteBackgroundTasks(key: string, count: number): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    entry.backgroundTasks = Math.max(0, count)
    if (count > 0) {
      entry.backgroundSince ??= this.#now()
      this.#clearIdle(entry)
      return
    }
    entry.backgroundSince = undefined
    if (!entry.busy) this.#scheduleIdle(entry)
  }

  async release(key: string, reason: ProviderSessionReleaseReason): Promise<void> {
    const entry = this.#entries.get(key)
    if (!entry) return
    // Drop every key (including aliases) that points at this session before closing it.
    for (const [candidate, other] of [...this.#entries]) {
      if (other === entry) this.#entries.delete(candidate)
    }
    this.#clearIdle(entry)
    this.#onReleased?.(key, reason)
    try {
      await entry.close()
    } catch {
      // A failed close must not resurrect a released session.
    }
  }

  async closeAll(reason: ProviderSessionReleaseReason = 'shutdown'): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((key) => this.release(key, reason)))
  }

  #clearIdle(entry: Entry<T>): void {
    if (!entry.idleTimer) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }

  #scheduleIdle(entry: Entry<T>): void {
    this.#clearIdle(entry)
    const backgroundHeld = entry.backgroundTasks > 0
    const delay = backgroundHeld
      ? Math.max(1, (entry.backgroundSince ?? this.#now()) + this.#maxBackgroundHoldMs - this.#now())
      : this.#idleMs
    const timer = setTimeout(() => {
      if (this.#entries.get(entry.key) !== entry) return
      void this.release(entry.key, backgroundHeld ? 'background_expired' : 'idle')
    }, delay)
    timer.unref?.()
    entry.idleTimer = timer
  }

  /** Evicts least-recently-used idle sessions so a new session fits under the cap. */
  async #makeRoom(): Promise<void> {
    while (this.#entries.size >= this.#maxSessions) {
      const idle = [...this.#entries.values()]
        .filter((entry) => !entry.busy && entry.backgroundTasks === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (!idle) throw new ProviderSessionCapExceededError()
      await this.release(idle.key, 'evicted')
    }
  }
}
