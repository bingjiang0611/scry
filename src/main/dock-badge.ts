import type { SessionAttentionSnapshot } from '../shared/session-attention'

export interface DockBadgeTerminalState {
  windowFocused: boolean
  sessionViewed: boolean
  needsAttention: boolean
}

export class DockBadgeState {
  private readonly unreadSessionKeys = new Set<string>()
  private viewedSessionKey: string | null = null
  private revision = 0

  constructor(
    private readonly setCount: (count: number) => void,
    private readonly onChange?: (snapshot: SessionAttentionSnapshot) => void
  ) {}

  view(sessionKey: string | null, windowFocused: boolean): void {
    this.viewedSessionKey = sessionKey
    if (sessionKey && windowFocused) this.clear(sessionKey)
  }

  focusWindow(): void {
    if (this.viewedSessionKey) this.clear(this.viewedSessionKey)
  }

  markTerminal(sessionKey: string, state: DockBadgeTerminalState): void {
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

  remove(sessionKey: string): void {
    if (this.viewedSessionKey === sessionKey) this.viewedSessionKey = null
    this.clear(sessionKey)
  }

  get count(): number {
    return this.unreadSessionKeys.size
  }

  snapshot(): SessionAttentionSnapshot {
    return {
      revision: this.revision,
      unreadSessionKeys: [...this.unreadSessionKeys]
    }
  }

  private clear(sessionKey: string): void {
    if (!this.unreadSessionKeys.delete(sessionKey)) return
    this.publish()
  }

  private publish(): void {
    this.revision += 1
    this.setCount(this.unreadSessionKeys.size)
    this.onChange?.(this.snapshot())
  }
}
