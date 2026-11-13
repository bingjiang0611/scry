import type { SessionAttentionSnapshot } from '../shared/session-attention'

export interface DockBadgeAttentionState {
  windowFocused: boolean
  sessionViewed: boolean
  needsAttention: boolean
}

export class DockBadgeState {
  private readonly unreadSessionKeys = new Set<string>()
  private readonly remoteSessionKeys = new Set<string>()
  // Daemon mode: the daemon's unread set, mirrored. The daemon cannot see this window's
  // focus or the session it shows, so this window decides what counts as viewed and
  // tells the daemon. `undefined` until the daemon's first snapshot: unknown, not empty.
  private daemonSessionKeys: Set<string> | undefined
  private daemonViewed?: (sessionKey: string) => void
  private viewedSessionKey: string | null = null
  // A conversation shows several native sessions at once (one per Provider binding), and a
  // side chat can show one beside the main pane: one group per view on screen.
  private readonly viewedGroups = new Map<string, ReadonlySet<string>>()
  private revision = 0

  constructor(
    private readonly setCount: (count: number) => void,
    private readonly onChange?: (snapshot: SessionAttentionSnapshot) => void
  ) {}

  view(sessionKey: string | null, windowFocused: boolean): void {
    this.viewedSessionKey = sessionKey
    if (windowFocused) this.clear(sessionKey)
  }

  /**
   * A conversation view shows these native sessions; an empty list means it closed. The
   * main pane's conversation replaces the single viewed session; a side chat beside a
   * session does not.
   */
  viewSessions(view: { id: string; main: boolean }, sessionKeys: readonly string[], windowFocused: boolean): void {
    if (sessionKeys.length === 0) {
      this.viewedGroups.delete(view.id)
      return
    }
    if (view.main) this.viewedSessionKey = null
    this.viewedGroups.set(view.id, new Set(sessionKeys))
    if (windowFocused) for (const key of sessionKeys) this.clear(key)
  }

  focusWindow(): void {
    this.clear(this.viewedSessionKey)
    for (const group of this.viewedGroups.values()) for (const key of group) this.clear(key)
  }

  // What the window shows right now, whichever way it came to show it.
  private shows(sessionKey: string): boolean {
    if (sessionKey === this.viewedSessionKey) return true
    for (const group of this.viewedGroups.values()) if (group.has(sessionKey)) return true
    return false
  }

  markAttention(sessionKey: string, state: DockBadgeAttentionState): void {
    if (!state.needsAttention) return
    if (state.sessionViewed) this.viewedSessionKey = sessionKey
    // A run that is not the focused one can still finish in the session on screen (a
    // conversation's run, a phone's run): the user is looking at it all the same.
    if (state.windowFocused && (state.sessionViewed || this.shows(sessionKey))) {
      this.clear(sessionKey)
      return
    }
    if (this.unreadSessionKeys.has(sessionKey)) return
    this.unreadSessionKeys.add(sessionKey)
    this.publish()
  }

  // Questions can arrive before the Provider supplies a native session ID.
  rekey(previousSessionKey: string, sessionKey: string): void {
    if (previousSessionKey === sessionKey) return
    if (this.viewedSessionKey === previousSessionKey) this.viewedSessionKey = sessionKey
    if (!this.unreadSessionKeys.delete(previousSessionKey)) return
    this.unreadSessionKeys.add(sessionKey)
    this.publish()
  }

  remove(sessionKey: string): void {
    if (this.viewedSessionKey === sessionKey) this.viewedSessionKey = null
    this.clear(sessionKey)
  }

  // 问题关闭（已答/取消）后该会话不再等待回答，未读角标随之失效：已存档/已切的会话没有入口
  // 再触发 view，如果不在这里释放，角标会永久停在 1。代价是同会话其他新结果的未读会被一并
  // 清掉；这是维护者明确接受的取舍，换来不会留下一个永远消不掉的假未读。
  releaseQuestionAttention(sessionKey: string | null, remainingPending: number): void {
    if (!sessionKey || remainingPending > 0) return
    this.remove(sessionKey)
  }

  /**
   * Remote sessions run on a paired host, so their attention is counted here but
   * owned by the remote classifier: this call replaces the whole remote set and the
   * caller removes a session once the user opens it.
   */
  setRemote(sessionKeys: readonly string[]): void {
    const next = new Set(sessionKeys)
    if (next.size === this.remoteSessionKeys.size && [...next].every((key) => this.remoteSessionKeys.has(key))) return
    this.remoteSessionKeys.clear()
    for (const key of next) this.remoteSessionKeys.add(key)
    this.publish()
  }

  // Unread state is process-local; the OS may still display a previous launch's badge.
  sync(): void {
    this.setCount(this.count)
  }

  get count(): number {
    return this.unreadSessionKeys.size + this.remoteSessionKeys.size + (this.daemonSessionKeys?.size ?? 0)
  }

  // Callers waiting for the daemon's first unread snapshot (whenDaemonKnown).
  private daemonWaiters: Array<() => void> = []

  /** Resolves true once the daemon's set is known, false if it is not within `timeoutMs`. */
  whenDaemonKnown(timeoutMs: number): Promise<boolean> {
    if (this.daemonSessionKeys !== undefined) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); resolve(true) }
      const timer = setTimeout(() => {
        this.daemonWaiters = this.daemonWaiters.filter((waiter) => waiter !== done)
        resolve(false)
      }, timeoutMs)
      this.daemonWaiters.push(done)
    })
  }

  get daemonAttentionKnown(): boolean {
    return this.daemonSessionKeys !== undefined
  }

  bindDaemon(viewed: (sessionKey: string) => void): void {
    this.daemonViewed = viewed
  }

  /** The daemon's whole unread set; a session this focused window shows is viewed now. */
  setDaemon(snapshot: SessionAttentionSnapshot, windowFocused: boolean): void {
    const next = new Set<string>()
    for (const key of snapshot.unreadSessionKeys) {
      if (windowFocused && this.shows(key)) this.daemonViewed?.(key)
      else next.add(key)
    }
    const same = this.daemonSessionKeys !== undefined && next.size === this.daemonSessionKeys.size &&
      [...next].every((key) => this.daemonSessionKeys!.has(key))
    this.daemonSessionKeys = next
    for (const wake of this.daemonWaiters.splice(0)) wake()
    if (!same) this.publish()
  }

  /** The daemon is gone: its set is unknown again, and no longer counted. */
  forgetDaemon(): void {
    if (this.daemonSessionKeys === undefined) return
    this.daemonSessionKeys = undefined
    this.publish()
  }

  // Local keys only: the renderer owns the remote set and reads it per connection.
  snapshot(): SessionAttentionSnapshot {
    return {
      revision: this.revision,
      unreadSessionKeys: [...this.unreadSessionKeys, ...(this.daemonSessionKeys ?? [])]
    }
  }

  private clear(sessionKey: string | null): void {
    const daemon = sessionKey !== null && this.daemonSessionKeys?.delete(sessionKey) === true
    if (daemon) this.daemonViewed?.(sessionKey)
    if (!sessionKey || (!this.unreadSessionKeys.delete(sessionKey) && !daemon)) {
      // Viewing an already-read session must still reconcile a stale native badge.
      this.sync()
      return
    }
    this.publish()
  }

  private publish(): void {
    this.revision += 1
    this.sync()
    this.onChange?.(this.snapshot())
  }
}

/**
 * `agent:unreadSessions`. In daemon mode the set is the daemon's, mirrored here; until its
 * first snapshot it is unknown, which is a named absence, never an empty list that reads
 * as "nothing unread".
 */
export function unreadSessionsAnswer(badge: DockBadgeState, daemonMode: boolean): SessionAttentionSnapshot {
  if (daemonMode && !badge.daemonAttentionKnown) throw new Error('daemon_capability_unavailable:agent:unreadSessions')
  return badge.snapshot()
}

/**
 * As unreadSessionsAnswer, but at daemon-mode start the renderer asks before the daemon's
 * first snapshot arrives: wait for it briefly instead of failing every start.
 */
export async function unreadSessionsAnswerWhenKnown(badge: DockBadgeState, daemonMode: boolean, waitMs = 5_000): Promise<SessionAttentionSnapshot> {
  if (daemonMode && !badge.daemonAttentionKnown) await badge.whenDaemonKnown(waitMs)
  return unreadSessionsAnswer(badge, daemonMode)
}
