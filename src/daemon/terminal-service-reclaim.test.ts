import { describe, expect, it } from 'vitest'
import { APP_EVENTS_MAX_WAIT_MS } from '../main/remote/app-event-feed'
import { CHECK_EVERY_MS, RECLAIM_AFTER_MS } from './terminal-service'

describe('terminal reclaim after an App crash', () => {
  it('stays within 90 s end to end', () => {
    expect(APP_EVENTS_MAX_WAIT_MS + RECLAIM_AFTER_MS + CHECK_EVERY_MS).toBeLessThanOrEqual(90_000)
  })
})
