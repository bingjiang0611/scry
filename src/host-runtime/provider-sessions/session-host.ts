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
  /** Identity written next to the session row; every adapter reports its own Provider id. */
  provider?: string
  onOpened?: (record: { key: string; provider: string; at: number }) => void
  onNativeSessionId?: (record: { key: string; provider: string; nativeSessionId: string; at: number }) => void
  onReleased?: (record: { key: string; provider: string; reason: ProviderSessionReleaseReason; at: number }) => void
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
  readonly #provider: string
  readonly #onOpened?: (record: { key: string; provider: string; at: number }) => void
  readonly #onNativeSessionId?: (record: { key: string; provider: string; nativeSessionId: string; at: number }) => void
  readonly #onReleased?: (record: { key: string; provider: string; reason: ProviderSessionReleaseReason; at: number }) => void
  // Opening keys reserve their slot before open() yields; aliases share the entry's waiters.
  readonly #opening = new Set<string>()
  readonly #waiters = new Map<string | Entry<T>, Set<() => void>>()

  constructor(options: ProviderSessionHostOptions = {}) {
    this.#idleMs = Math.min(30 * 60_000, Math.max(15 * 60_000, options.idleMs ?? DEFAULT_IDLE_MS))
    this.#maxBackgroundHoldMs = options.maxBackgroundHoldMs ?? DEFAULT_MAX_BACKGROUND_HOLD_MS
    this.#maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS)
    this.#now = options.now ?? Date.now
    this.#provider = options.provider ?? 'unknown'
    this.#onOpened = options.onOpened
    this.#onNativeSessionId = options.onNativeSessionId
    this.#onReleased = options.onReleased
  }

  get size(): number {
    return this.#liveSessions()
  }

  /** R14: an alias is the same process under a second key, so only distinct entries count. */
  #liveSessions(): number {
    return new Set(this.#entries.values()).size
  }

  /**
   * Reuses a live session for `key`, or opens one. A busy session is waited for, never closed:
   * closing it would kill a turn another conversation is still running (R4).
   */
  async acquire(
    key: string,
    open: () => Promise<{ value: T; sessionId: string; close: () => Promise<void> | void; closed?: boolean }>,
    isClosed?: (entry: { value: T; sessionId: string }) => boolean,
    signal?: AbortSignal
  ): Promise<{ value: T; sessionId: string; reused: boolean }> {
    for (;;) {
      signal?.throwIfAborted()
      const existing = this.#entries.get(key)
      if (existing) {
        if (isClosed?.(existing)) {
          await this.release(key, 'error')
        } else if (existing.busy) {
          await this.#waitForIdle(existing, signal)
        } else {
          existing.busy = true
          existing.lastUsedAt = this.#now()
          this.#clearIdle(existing)
          return { value: existing.value, sessionId: existing.sessionId, reused: true }
        }
        continue
      }
      if (this.#opening.has(key)) {
        await this.#waitForIdle(key, signal)
        continue
      }
      if (this.#liveSessions() + this.#opening.size >= this.#maxSessions) {
        const idle = [...new Set(this.#entries.values())]
          .filter((entry) => !entry.busy && entry.backgroundTasks === 0)
          .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
        if (!idle) throw new ProviderSessionCapExceededError()
        await this.release(idle.key, 'evicted')
        continue
      }
      this.#opening.add(key)
      try {
        const opened = await open()
        if (signal?.aborted) {
          await Promise.resolve().then(opened.close).catch(() => undefined)
          signal.throwIfAborted()
        }
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
        this.#onOpened?.({ key, provider: this.#provider, at: entry.openedAt })
        return { value: entry.value, sessionId: entry.sessionId, reused: false }
      } finally {
        this.#opening.delete(key)
        this.#wakeWaiters(key)
      }
    }
  }

  /**
   * Registers a second key for a live session. A turn that opened a fresh native session is later
   * resumed by that native id, which derives a different key; the alias makes the second turn reuse
   * the process it already owns instead of spawning another one.
   */
  alias(fromKey: string, toKey: string): boolean {
    const entry = this.#entries.get(fromKey)
    if (!entry || this.#opening.has(toKey) || this.#entries.has(toKey)) return false
    this.#entries.set(toKey, entry)
    return true
  }

  /** Marks the turn finished. `reusable: false` releases the process immediately. */
  async settle(key: string, options: { reusable: boolean; keepForBackground?: boolean }): Promise<void> {
    const entry = this.#entries.get(key)
    if (!entry) return
    entry.busy = false
    this.#wakeWaiters(entry)
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

  /** Records the Provider's own session id once the turn established it. */
  noteNativeSessionId(key: string, nativeSessionId: string): void {
    if (!this.#entries.has(key)) return
    this.#onNativeSessionId?.({
      key,
      provider: this.#provider,
      nativeSessionId,
      at: this.#now()
    })
  }

  /** R4: resolves when the entry stops being busy, or when it is released. */
  #waitForIdle(key: string | Entry<T>, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiters = this.#waiters.get(key) ?? new Set<() => void>()
      const ready = (): void => {
        signal?.removeEventListener('abort', cancel)
        resolve()
      }
      const cancel = (): void => {
        waiters.delete(ready)
        if (waiters.size === 0) this.#waiters.delete(key)
        reject(signal?.reason)
      }
      waiters.add(ready)
      this.#waiters.set(key, waiters)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  #wakeWaiters(key: string | Entry<T>): void {
    const list = this.#waiters.get(key)
    if (!list) return
    this.#waiters.delete(key)
    for (const resolve of list) resolve()
  }

  async release(key: string, reason: ProviderSessionReleaseReason): Promise<void> {
    const entry = this.#entries.get(key)
    if (!entry) return
    // Drop every key (including aliases) that points at this session before closing it.
    for (const [candidate, other] of [...this.#entries]) {
      if (other === entry) this.#entries.delete(candidate)
    }
    this.#clearIdle(entry)
    this.#onReleased?.({ key, provider: this.#provider, reason, at: this.#now() })
    this.#wakeWaiters(entry)
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

}
