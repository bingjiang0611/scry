import { describe, expect, it, vi } from 'vitest'
import {
  COMPACT_COMMAND,
  COMPACTION_CACHE_TTL_MS,
  COMPACTION_LEAD_MS,
  createIdleCompaction,
  decideIdleCompaction,
  idleCompactionSettings
} from './idle-compaction'

const settings = { enabled: true, cacheTtlMs: COMPACTION_CACHE_TTL_MS, leadMs: COMPACTION_LEAD_MS }

// C5: compaction exists to keep the next turn's prompt cheap, so the rules are about *when* — not
// before the cache is nearly gone, never while a turn runs, and once per idle window.
describe('idle compaction decision', () => {
  it('is on by default and off only when asked', () => {
    expect(idleCompactionSettings({}).enabled).toBe(true)
    expect(idleCompactionSettings({ SCRY_IDLE_COMPACTION: '0' }).enabled).toBe(false)
  })

  it('waits until the cache is within the lead window, then compacts', () => {
    const state = { lastActiveAt: 1_000, compactedFor: undefined, busy: false }
    const due = 1_000 + COMPACTION_CACHE_TTL_MS - COMPACTION_LEAD_MS
    expect(decideIdleCompaction(state, settings, due - 1)).toEqual({ status: 'waiting', at: due })
    expect(decideIdleCompaction(state, settings, due)).toEqual({ status: 'compact', at: due })
  })

  it('never compacts while a turn is running, and never when compaction is off', () => {
    const running = { lastActiveAt: 1_000, compactedFor: undefined, busy: true }
    expect(decideIdleCompaction(running, settings, 10_000_000)).toEqual({ status: 'busy' })
    const idle = { lastActiveAt: 1_000, compactedFor: undefined, busy: false }
    expect(decideIdleCompaction(idle, { ...settings, enabled: false }, 10_000_000)).toEqual({ status: 'disabled' })
  })

  it('compacts once per idle window, and again after the next turn settles', () => {
    const once = { lastActiveAt: 1_000, compactedFor: 1_000, busy: false }
    expect(decideIdleCompaction(once, settings, 10_000_000).status).toBe('waiting')
    const next = { lastActiveAt: 9_000, compactedFor: 1_000, busy: false }
    expect(decideIdleCompaction(next, settings, 10_000_000).status).toBe('compact')
  })
})

describe('idle compaction timer', () => {
  it('sends one /compact when the window is due and re-arms only after the next settle', () => {
    const sent: string[] = []
    const armed: number[] = []
    let clock = 0
    const timer = createIdleCompaction({
      settings: () => settings,
      send: (command) => sent.push(command),
      now: () => clock,
      schedule: (_fn, ms) => { armed.push(ms); return {} }
    })
    timer.noteSettled(0)
    // First arm is the full cache window minus the lead.
    expect(armed).toEqual([COMPACTION_CACHE_TTL_MS - COMPACTION_LEAD_MS])
    clock = COMPACTION_CACHE_TTL_MS - COMPACTION_LEAD_MS
    timer.pump()
    expect(sent).toEqual([COMPACT_COMMAND])
    // Nothing more is armed for this idle window.
    expect(armed).toHaveLength(1)
    clock += 10_000
    timer.noteBusy()
    timer.pump()
    expect(sent).toEqual([COMPACT_COMMAND])
    timer.stop()
  })

  it('does not compact a session that never ran a turn', () => {
    const send = vi.fn()
    const timer = createIdleCompaction({ settings: () => settings, send, now: () => 10_000_000, schedule: () => ({}) })
    timer.pump()
    expect(send).not.toHaveBeenCalled()
    timer.stop()
  })
})
