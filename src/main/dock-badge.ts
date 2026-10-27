import type { SessionAttentionSnapshot } from '../shared/session-attention'

export interface DockBadgeAttentionState {
  windowFocused: boolean
  sessionViewed: boolean
  needsAttention: boolean
}

export class DockBadgeState {
  private readonly unreadSessionKeys = new Set<string>()
  private readonly remoteSessionKeys = new Set<string>()
  private viewedSessionKey: string | null = null
  private revision = 0

  constructor(
    private readonly setCount: (count: number) => void,
    private readonly onChange?: (snapshot: SessionAttentionSnapshot) => void
  ) {}

  view(sessionKey: string | null, windowFocused: boolean): void {
    this.viewedSessionKey = sessionKey
    if (windowFocused) this.clear(sessionKey)
  }

  focusWindow(): void {
    this.clear(this.viewedSessionKey)
  }

  markAttention(sessionKey: string, state: DockBadgeAttentionState): void {
    if (!state.needsAttention) return
    if (state.sessionViewed) this.viewedSessionKey = sessionKey
    if (state.windowFocused && state.sessionViewed) {
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
    return this.unreadSessionKeys.size + this.remoteSessionKeys.size
  }

  // Local keys only: the renderer owns the remote set and reads it per connection.
  snapshot(): SessionAttentionSnapshot {
    return {
      revision: this.revision,
      unreadSessionKeys: [...this.unreadSessionKeys]
    }
  }

  private clear(sessionKey: string | null): void {
    if (!sessionKey || !this.unreadSessionKeys.delete(sessionKey)) {
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
