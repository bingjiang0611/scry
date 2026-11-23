import { describe, expect, it } from 'vitest'
import { SUBSCRIBE_MAX_WAIT_MS } from '../host-runtime/orchestration/subscribe-engine'
import { CHECK_EVERY_MS, RECLAIM_AFTER_MS } from './terminal-service'

// P3-terminal: shells of a crashed App are reclaimed "within about 90 s". Idle time only
// starts once the App's parked subscription ends, so the bound is the sum below.
describe('terminal reclaim after an App crash', () => {
  it('stays within 90 s end to end', () => {
    expect(SUBSCRIBE_MAX_WAIT_MS + RECLAIM_AFTER_MS + CHECK_EVERY_MS).toBeLessThanOrEqual(90_000)
  })
})
