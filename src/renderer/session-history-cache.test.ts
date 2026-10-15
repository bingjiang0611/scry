import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderContext } from '@shared/provider'
import type { SessionHistoryPage } from './env'
import {
  SessionHistorySnapshotCache, SESSION_SNAPSHOT_IDLE_MS, SESSION_SNAPSHOT_MAX_BYTES,
  SESSION_SNAPSHOT_MAX_ENTRIES, SESSION_SNAPSHOT_MAX_TURNS
} from './session-history-cache'

const context: ProviderContext = { providerId: 'claude', agentProfileId: 'primary', cwd: '/workspace', externalSessionId: 'session' }
const page = (count = 1): SessionHistoryPage => ({
  turns: Array.from({ length: count }, (_, index) => ({ userText: `turn ${index}`, items: [], done: true })),
  offset: 0, totalTurns: count, hasOlder: false, completeness: 'complete'
})

describe('recent session snapshots remain bounded display-only data', () => {
  let cache: SessionHistorySnapshotCache
  beforeEach(() => { vi.useFakeTimers(); cache = new SessionHistorySnapshotCache() })
  afterEach(() => { cache.clear(); vi.useRealTimers() })

  it('partitions provider, profile, cwd and native session identities', () => {
    const value = page()
    cache.put(context, value)
    expect(cache.get(context)?.turns).toEqual(value.turns)
    for (const changed of [{ providerId: 'codex' as const }, { agentProfileId: 'other' },
      { cwd: '/elsewhere' }, { externalSessionId: 'other' }]) {
      expect(cache.get({ ...context, ...changed })).toBeUndefined()
    }
    cache.put({ ...context, externalSessionId: undefined }, value)
    expect(cache.get({ ...context, externalSessionId: undefined })).toBeUndefined()
  })

  it('shares unchanged authoritative wire data but never reuses changed evidence', () => {
    const first = cache.put(context, page())
    const unchanged = cache.put(context, structuredClone(first))
    expect(unchanged).toBe(first)
    expect(unchanged.turns).toBe(first.turns)
    const changed = structuredClone(first)
    changed.turns[0].errorHint = 'Provider evidence changed'
    const refreshed = cache.put(context, changed)
    expect(refreshed).not.toBe(first)
    expect(refreshed.turns[0].errorHint).toBe('Provider evidence changed')
  })

  it('keeps only the latest 40 turns with truthful history metadata', () => {
    const value = page(100)
    cache.put(context, value)
    const hit = cache.get(context)!
    expect(hit.turns).toHaveLength(SESSION_SNAPSHOT_MAX_TURNS)
    expect(hit.turns[0].userText).toBe('turn 60')
    expect(hit).toMatchObject({ offset: 60, totalTurns: 100, hasOlder: true, completeness: 'partial' })
    expect(value.turns).toHaveLength(100)
  })

  it('does not cache earlier history pages or currently running partial turns', () => {
    cache.put(context, { ...page(), offset: 0, totalTurns: 2, hasOlder: false, completeness: 'partial' })
    expect(cache.get(context)).toBeUndefined()
    cache.put(context, { ...page(), turns: [{ userText: 'running', items: [], done: false }] })
    expect(cache.get(context)).toBeUndefined()
  })

  it('evicts least recently used entries by count', () => {
    const contexts = Array.from({ length: SESSION_SNAPSHOT_MAX_ENTRIES + 1 }, (_, index) => ({ ...context, externalSessionId: `s${index}` }))
    for (const item of contexts.slice(0, -1)) cache.put(item, page())
    cache.get(contexts[0])
    cache.put(contexts.at(-1)!, page())
    expect(cache.get(contexts[0])).toBeDefined()
    expect(cache.get(contexts[1])).toBeUndefined()
  })

  it('enforces estimated byte limits without losing the authoritative input page', () => {
    const large = page()
    large.turns[0].userText = 'x'.repeat(SESSION_SNAPSHOT_MAX_BYTES / 3)
    cache.put(context, large)
    const other = { ...context, externalSessionId: 'other' }
    cache.put(other, large)
    expect(cache.get(context)).toBeUndefined()
    expect(cache.get(other)).toBeDefined()
    const oversized = page()
    oversized.turns[0].userText = 'x'.repeat(SESSION_SNAPSHOT_MAX_BYTES)
    cache.put(context, oversized)
    expect(cache.get(context)).toBeUndefined()
    expect(oversized.turns[0].userText).toHaveLength(SESSION_SNAPSHOT_MAX_BYTES)
  })

  it('releases expired snapshots without polling and extends only the accessed entry', () => {
    const other = { ...context, externalSessionId: 'other' }
    cache.put(context, page()); cache.put(other, page())
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    cache.get(context)
    vi.advanceTimersByTime(SESSION_SNAPSHOT_IDLE_MS - 1000)
    expect(cache.get(other)).toBeUndefined()
    expect(cache.get(context)).toBeDefined()
    vi.advanceTimersByTime(SESSION_SNAPSHOT_IDLE_MS)
    expect(cache.get(context)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fences a pending read across deletion/recording and releases the expiry timer', () => {
    const revision = cache.revision
    cache.put(context, page())
    cache.clear()
    cache.put(context, page(), revision)
    expect(cache.get(context)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    cache.put(context, page(), cache.revision)
    expect(cache.get(context)).toBeDefined()
    cache.delete(context)
    expect(cache.get(context)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
