import type { Query } from '@qoder-ai/qoder-agent-sdk'
import { createQoderSession, type QoderSession, type QoderTurnChannel } from './qoder-session'
import {
  SESSION_POOL_CAP,
  sessionIdleWindowMs,
  type SessionLifecycleObserver,
  type SessionReleaseReason
} from './session-pool-policy'

/** A kept Qoder session, plus the per-turn state the SDK callbacks read. */
export interface QoderSessionLease {
  readonly key: string
  readonly query: Query
  beginTurn(): QoderTurnChannel
  /** Hands the next user message to the SDK; the session's prompt stream stays open for the next turn. */
  send(message: unknown): void
  /** The turn ended; the session may now wait for its idle window. */
  release(): void
  close(): Promise<void>
}

export interface QoderSessionPoolOptions {
  /** Creates the SDK query for a new session; the pool owns its single reader and prompt stream. */
  open: (key: string, prompt: AsyncIterable<unknown>, signal: AbortSignal) => Query
  provider: string
  observer?: SessionLifecycleObserver
  idleMs?: number
  cap?: number
  now?: () => number
}

export interface QoderSessionPool {
  acquire(key: string): QoderSessionLease
  /** Every live key, for a caller that must report what the pool holds. */
  keys(): string[]
  disposeAll(reason?: SessionReleaseReason): Promise<void>
}

interface Entry {
  lease: QoderSessionLease
  session: QoderSession
  prompt: ReturnType<typeof createPromptStream>
  controller: AbortController
  idleTimer: ReturnType<typeof setTimeout> | undefined
  lastUsed: number
}

/**
 * C1: a Qoder session is reused only for the exact key it was opened with — the caller folds the
 * continuation identity, permission mode and MCP fingerprint into that key, so a mismatch opens a new
 * session instead of reusing one whose options no longer describe this turn.
 *
 * Lifetime follows the shared policy: idle 20 minutes clamped to 15–30, cap 8 with LRU eviction.
 */
export function createQoderSessionPool(options: QoderSessionPoolOptions): QoderSessionPool {
  const idleMs = options.idleMs ?? sessionIdleWindowMs(process.env, 'SCRY_QODER_IDLE_MS')
  const cap = options.cap ?? SESSION_POOL_CAP
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()

  const closeEntry = async (key: string, reason: SessionReleaseReason): Promise<void> => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.controller.abort()
    entry.prompt.close()
    options.observer?.onReleased?.(key, reason, now())
    await entry.session.close()
  }

  const startIdle = (key: string, entry: Entry): void => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => { void closeEntry(key, 'idle') }, idleMs)
    // A timer must not hold the process open on its own.
    entry.idleTimer.unref?.()
  }

  const evictIfNeeded = async (): Promise<void> => {
    while (entries.size > cap) {
      let oldest: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of entries) {
        if (entry.idleTimer === undefined) continue
        if (entry.lastUsed < oldestAt) { oldestAt = entry.lastUsed; oldest = key }
      }
      // A busy session is never evicted: its turn is still using the process.
      if (!oldest) return
      await closeEntry(oldest, 'lru')
    }
  }

  return {
    acquire(key) {
      const existing = entries.get(key)
      if (existing && existing.idleTimer !== undefined) {
        if (existing.idleTimer) clearTimeout(existing.idleTimer)
        existing.idleTimer = undefined
        existing.lastUsed = now()
        return existing.lease
      }
      const controller = new AbortController()
      const prompt = createPromptStream()
      const query = options.open(key, prompt.stream, controller.signal)
      const session = createQoderSession(query)
      const entry: Entry = {
        controller,
        prompt,
        session,
        idleTimer: undefined,
        lastUsed: now(),
        lease: {
          key,
          query,
          beginTurn: () => session.beginTurn(),
          send: (message) => prompt.push(message),
          release: () => {
            entry.lastUsed = now()
            startIdle(key, entry)
          },
          close: () => closeEntry(key, 'dispose')
        }
      }
      entries.set(key, entry)
      options.observer?.onOpened?.(key, options.provider, now())
      void evictIfNeeded()
      return entry.lease
    },
    keys: () => [...entries.keys()],
    async disposeAll() {
      for (const key of [...entries.keys()]) await closeEntry(key, 'dispose')
    }
  }
}

/**
 * The SDK keeps a session alive only while the prompt is an async iterable, so the prompt outlives a
 * turn. `beginTurn` is the caller's promise that the next pushed message belongs to a fresh turn.
 */
function createPromptStream(): {
  stream: AsyncIterable<unknown>
  push: (message: unknown) => void
  close: () => void
} {
  let wake: (() => void) | undefined
  const queued: unknown[] = []
  let open = true
  const stream = (async function* (): AsyncIterable<unknown> {
    for (;;) {
      if (queued.length > 0) { yield queued.shift(); continue }
      if (!open) return
      await new Promise<void>((resolve) => { wake = resolve })
    }
  })() as AsyncIterable<unknown>
  return {
    stream,
    push: (message) => { queued.push(message); const w = wake; wake = undefined; w?.() },
    // Ends the stream the SDK reads, so closing a session does not leave a parked generator behind.
    close: () => { open = false; const w = wake; wake = undefined; w?.() }
  }
}
