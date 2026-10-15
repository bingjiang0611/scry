import type { ProviderContext } from '@shared/provider'
import type { SessionHistoryPage } from './env'

export const SESSION_SNAPSHOT_MAX_ENTRIES = 8
export const SESSION_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024
export const SESSION_SNAPSHOT_MAX_TURNS = 40
export const SESSION_SNAPSHOT_IDLE_MS = 5 * 60_000

interface SnapshotEntry {
  page: SessionHistoryPage
  bytes: number
  expiresAt: number
}

function snapshotKey(context: ProviderContext): string {
  return JSON.stringify([context.providerId, context.agentProfileId ?? null,
    context.cwd ?? '', context.externalSessionId ?? null])
}

/** Display-only, recent-page cache. It never owns a subscription or authorizes
 * resume. A hit must remain labeled cached until the normal main read settles.
 * Bounds are estimated UTF-16 JSON bytes, not an exact JS heap measurement.
 */
export class SessionHistorySnapshotCache {
  private entries = new Map<string, SnapshotEntry>()
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  revision = 0

  get(context: ProviderContext): SessionHistoryPage | undefined {
    const key = snapshotKey(context)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.remove(key)
      this.scheduleExpiry()
      return undefined
    }
    this.entries.delete(key)
    entry.expiresAt = Date.now() + SESSION_SNAPSHOT_IDLE_MS
    this.entries.set(key, entry)
    this.scheduleExpiry()
    return entry.page
  }

  put(context: ProviderContext, page: SessionHistoryPage, expectedRevision = this.revision): SessionHistoryPage {
    if (expectedRevision !== this.revision || !context.externalSessionId) return page
    const key = snapshotKey(context)
    const previous = this.entries.get(key)
    this.remove(key)
    // Only initial recent pages are cached. Expanded history and live partial
    // turns must not grow a snapshot or impersonate a current runtime.
    if (page.offset + page.turns.length !== page.totalTurns || page.turns.some(turn => turn.done === false)) {
      this.scheduleExpiry()
      return page
    }
    const turns = page.turns.slice(-SESSION_SNAPSHOT_MAX_TURNS)
    const offset = page.offset + page.turns.length - turns.length
    let snapshot: SessionHistoryPage = {
      ...page, turns, offset, hasOlder: offset > 0,
      completeness: offset === 0 ? 'complete' : 'partial'
    }
    const representation = JSON.stringify(snapshot)
    const bytes = representation.length * 2
    if (bytes > SESSION_SNAPSHOT_MAX_BYTES) {
      this.scheduleExpiry()
      return page
    }
    // Authority still comes from the completed main read. Exact wire equality
    // lets unchanged Markdown/event arrays keep their React memo identities;
    // a hash alone would risk showing stale evidence after a collision.
    if (previous?.bytes === bytes && JSON.stringify(previous.page) === representation) snapshot = previous.page
    while (this.entries.size >= SESSION_SNAPSHOT_MAX_ENTRIES || this.bytes + bytes > SESSION_SNAPSHOT_MAX_BYTES) {
      this.remove(this.entries.keys().next().value!)
    }
    this.entries.set(key, { page: snapshot, bytes, expiresAt: Date.now() + SESSION_SNAPSHOT_IDLE_MS })
    this.bytes += bytes
    this.scheduleExpiry()
    return turns.length === page.turns.length ? snapshot : page
  }

  delete(context: ProviderContext): void {
    this.remove(snapshotKey(context))
    this.scheduleExpiry()
  }

  clear(): void {
    this.revision += 1
    this.entries.clear()
    this.bytes = 0
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.bytes -= entry.bytes
    this.entries.delete(key)
  }

  private scheduleExpiry(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.entries.size === 0) return
    const expiresAt = Math.min(...Array.from(this.entries.values(), entry => entry.expiresAt))
    this.timer = setTimeout(() => {
      for (const [key, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.remove(key)
      this.scheduleExpiry()
    }, Math.max(0, expiresAt - Date.now()))
  }
}
