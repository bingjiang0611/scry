import { describe, expect, it } from 'vitest'
import type { RecorderOpenTurnState } from './runtime-state'
import { recordStartedAt } from './recorder-segment'


const open = (overrides: Partial<RecorderOpenTurnState>): RecorderOpenTurnState => ({
  schemaVersion: 1,
  provider: 'qoder',
  sessionId: 's',
  generation: 1,
  turnIndex: 1,
  status: 'open',
  startedAt: '2026-11-16T08:03:18.814Z',
  ...overrides
})

describe('记录起点', () => {
  it('真实提问时间优先于开启采集的时间', () => {
    expect(recordStartedAt(open({}), '2026-11-16T08:02:34.361Z')).toBe('2026-11-16T08:02:34.361Z')
  })

  it('transcript 没有提问时间时退回开启采集的时间，不编造', () => {
    expect(recordStartedAt(open({}), undefined)).toBe('2026-11-16T08:03:18.814Z')
  })

  it('接续段用自己的 wake 起点，不用前一段的提问时间', () => {
    const continuation = open({ continuation: true, startedAt: '2026-11-16T09:10:00.000Z' })
    expect(recordStartedAt(continuation, '2026-11-16T08:02:34.361Z')).toBe('2026-11-16T09:10:00.000Z')
  })
})
