import type { Query } from '@qoder-ai/qoder-agent-sdk'
import { createQoderSession, type QoderSession, type QoderTurnChannel } from './qoder-session'
import {
  SESSION_POOL_CAP,
  sessionIdleWindowMs,
  type SessionLifecycleObserver,
  type SessionReleaseReason
} from './session-pool-policy'

/**
 * R3: the session's SDK callbacks (permission hook, exit and pid reports, task control) belong to
 * whichever turn is running now, not to the turn that opened the process.
 */
export interface QoderSessionTurnSlot {
  /** Reassigned by each turn before it begins; the opener's closures read it. */
  current: unknown
  /** Owned by the session: the transport outlives one turn. */
  transport?: unknown
}

/** A kept Qoder session, plus the per-turn state the SDK callbacks read. */
export interface QoderSessionLease {
  readonly key: string
  readonly query: Query
  /** The mutable per-turn slot shared by every turn of this session. */
  readonly turn: QoderSessionTurnSlot
  beginTurn(): QoderTurnChannel
  /** Hands the next user message to the SDK; the session's prompt stream stays open for the next turn. */
  send(message: unknown): void
  /** The native session this CLI reported, so the observer can bind it to the key. */
  recordNativeSession(nativeSessionId: string): void
  /** C3: messages that arrive after the turn ended — a settled turn's child still reports here. */
  watchIdle(listener: (message: Record<string, unknown>) => void): () => void
  /**
   * The turn ended; the session may now wait for its idle window. `dead` says the process went away
   * during the turn, so it cannot serve another one (R12).
   */
  release(options?: { dead?: boolean }): void
  /** The CLI reported the process gone: the next acquire must open a new one (R12). */
  markExited(): void
  close(): Promise<void>
}

export interface QoderOpenedSession {
  query: Query
  /** Owned by the session, not the turn: a per-session MCP config file outlives one turn. */
  dispose?: () => void
}

/**
 * Creates the SDK query for a new session; the pool supplies the prompt stream and owns its reader.
 * The turn slot lets those closures reach the turn that is running now (R3).
 */
export type QoderSessionOpener = (
  prompt: AsyncIterable<unknown>,
  signal: AbortSignal,
  turn: QoderSessionTurnSlot
) => QoderOpenedSession

export interface QoderSessionPoolOptions {
  provider: string
  observer?: SessionLifecycleObserver
  idleMs?: number
  cap?: number
  now?: () => number
}

export interface QoderSessionPool {
  /** `open` runs only when no live session holds the key; the key alone decides reuse. */
  acquire(key: string, open: QoderSessionOpener): QoderSessionLease
  /** Every live key, for a caller that must report what the pool holds. */
  keys(): string[]
  disposeAll(reason?: SessionReleaseReason): Promise<void>
}

interface Entry {
  lease: QoderSessionLease
  closed: boolean
  /** The process is gone; the entry is only kept until `acquire` replaces it. */
  exited: boolean
  turn: QoderSessionTurnSlot
  session: QoderSession
  prompt: ReturnType<typeof createPromptStream>
  dispose: (() => void) | undefined
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
  /**
   * R12: a key maps to the entries that were opened for it. A busy session is never overwritten by the
   * next acquire — a second run under the same key starts its own process, and each entry's idle timer
   * closes only itself.
   */
  const entries = new Map<string, Entry[]>()
  /** R3: native session id -> the entry that reported it, so a later turn finds its process. */
  const nativeAliases = new Map<string, Entry>()

  const forget = (key: string, entry: Entry): void => {
    entry.closed = true
    const list = entries.get(key)
    if (!list) return
    const rest = list.filter((row) => row !== entry)
    if (rest.length === 0) entries.delete(key)
    else entries.set(key, rest)
  }

  const closeEntry = async (key: string, entry: Entry, reason: SessionReleaseReason): Promise<void> => {
    if (entry.closed) return
    forget(key, entry)
    for (const [nativeId, owner] of nativeAliases) {
      if (owner === entry) nativeAliases.delete(nativeId)
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.controller.abort()
    entry.prompt.close()
    try { entry.dispose?.() } catch { /* the session is gone either way */ }
    options.observer?.onReleased?.(key, reason, now())
    await entry.session.close()
  }

  const startIdle = (key: string, entry: Entry): void => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => { void closeEntry(key, entry, 'idle') }, idleMs)
    // A timer must not hold the process open on its own.
    entry.idleTimer.unref?.()
  }

  const keyOfEntry = (target: Entry): string => {
    for (const [key, list] of entries) if (list.includes(target)) return key
    return target.lease.key
  }

  const allEntries = (): Array<[string, Entry]> => {
    const rows: Array<[string, Entry]> = []
    for (const [key, list] of entries) for (const entry of list) rows.push([key, entry])
    return rows
  }

  const evictIfNeeded = async (): Promise<void> => {
    while (allEntries().length > cap) {
      let oldest: [string, Entry] | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const row of allEntries()) {
        const [, entry] = row
        if (entry.idleTimer === undefined) continue
        if (entry.lastUsed < oldestAt) { oldestAt = entry.lastUsed; oldest = row }
      }
      // A busy session is never evicted: its turn is still using the process.
      if (!oldest) return
      await closeEntry(oldest[0], oldest[1], 'lru')
    }
  }

  const aliasTarget = (key: string): Entry | undefined => {
    const match = /^native:([^|]+)\|(.*)$/.exec(key)
    if (!match) return undefined
    const entry = nativeAliases.get(match[1]!)
    if (!entry) return undefined
    if (entry.closed) { nativeAliases.delete(match[1]!); return undefined }
    // Reuse only when the turn asks for the same options the session was opened with.
    return entry.lease.key.endsWith(`|${match[2]}`) ? entry : undefined
  }

  /** A busy entry for the same key is not reusable, and a dead one must not be handed out. */
  const reusable = (list: readonly Entry[] | undefined): Entry | undefined => {
    if (!list) return undefined
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index]!
      if (entry.closed) continue
      if (entry.exited) {
        void closeEntry(keyOfEntry(entry), entry, 'crashed')
        continue
      }
      if (entry.idleTimer !== undefined) return entry
    }
    return undefined
  }

  return {
    acquire(key, open) {
      const existing = reusable(entries.get(key)) ?? reusable([aliasTarget(key)].filter((row): row is Entry => !!row))
      if (existing && existing.idleTimer !== undefined) {
        if (existing.idleTimer) clearTimeout(existing.idleTimer)
        existing.idleTimer = undefined
        existing.lastUsed = now()
        return existing.lease
      }
      const controller = new AbortController()
      const prompt = createPromptStream()
      const turn: QoderSessionTurnSlot = { current: undefined }
      const opened = open(prompt.stream, controller.signal, turn)
      const session = createQoderSession(opened.query)
      const entry: Entry = {
        closed: false,
        exited: false,
        turn,
        controller,
        prompt,
        dispose: opened.dispose,
        session,
        idleTimer: undefined,
        lastUsed: now(),
        lease: {
          key,
          query: opened.query,
          turn,
          beginTurn: () => session.beginTurn(),
          send: (message) => prompt.push(message),
          recordNativeSession: (nativeSessionId) => {
            // R3: the alias is how the next turn of this conversation finds this process again.
            nativeAliases.set(nativeSessionId, entry)
            options.observer?.onNativeSessionId?.(key, nativeSessionId)
          },
          watchIdle: (listener) => session.watchIdle(listener),
          release: (releaseOptions) => {
            // R12: a session whose process died during the turn cannot serve the next one.
            if (releaseOptions?.dead || entry.exited) { void closeEntry(key, entry, 'crashed'); return }
            entry.lastUsed = now()
            startIdle(key, entry)
          },
          markExited: () => { entry.exited = true },
          close: () => closeEntry(key, entry, 'dispose')
        }
      }
      const list = entries.get(key) ?? []
      list.push(entry)
      entries.set(key, list)
      options.observer?.onOpened?.(key, options.provider, now())
      void evictIfNeeded()
      return entry.lease
    },
    keys: () => [...entries.keys()],
    async disposeAll() {
      for (const [key, entry] of allEntries()) await closeEntry(key, entry, 'dispose')
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
