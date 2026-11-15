/**
 * A stop clicked after send but before main returns the runId has no run to address: the
 * renderer only shows an optimistic turn. Round seven G2 clicked stop 55 ms after send; the
 * click was dropped and the turn ran to completion. Bind such a stop to the start it was
 * clicked during, and hand it over once that start's runId exists. A start that fails or a
 * later start never inherits it.
 */
export class PendingStartStop<Token extends object> {
  private pending: Token | null = null
  private readonly requested = new WeakSet<Token>()

  begin(token: Token): void {
    this.pending = token
  }

  /** True when a start is pending and the stop was recorded for it. */
  request(): boolean {
    if (!this.pending) return false
    this.requested.add(this.pending)
    return true
  }

  /** Ends the start; true when a stop was requested during it and must now be sent. */
  settle(token: Token): boolean {
    if (this.pending === token) this.pending = null
    return this.requested.delete(token)
  }
}
