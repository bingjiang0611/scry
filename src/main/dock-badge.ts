export interface DockBadgeTerminalState {
  windowFocused: boolean
  sessionViewed: boolean
  needsAttention: boolean
}

export class DockBadgeState {
  private readonly unreadSessionKeys = new Set<string>()
  private viewedSessionKey: string | null = null

  constructor(private readonly setCount: (count: number) => void) {}

  view(sessionKey: string | null, windowFocused: boolean): void {
    this.viewedSessionKey = sessionKey
    if (sessionKey && windowFocused) this.clear(sessionKey)
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
    this.setCount(this.unreadSessionKeys.size)
  }

  focusWindow(): void {
    if (this.viewedSessionKey) this.clear(this.viewedSessionKey)
  }

  remove(sessionKey: string): void {
    this.clear(sessionKey)
  }

  get count(): number {
    return this.unreadSessionKeys.size
  }

  private clear(sessionKey: string): void {
    if (!this.unreadSessionKeys.delete(sessionKey)) return
    this.setCount(this.unreadSessionKeys.size)
  }
}
