import { describe, expect, it } from 'vitest'
import { PendingStartStop } from './pending-start-stop'

describe('PendingStartStop', () => {
  it('delivers a stop clicked during a start once that start settles, exactly once', () => {
    const stops = new PendingStartStop<object>()
    const start = {}
    stops.begin(start)
    expect(stops.request()).toBe(true)
    expect(stops.settle(start)).toBe(true)
    expect(stops.settle(start)).toBe(false)
    expect(stops.request()).toBe(false)
  })

  it('has nothing to stop when no start is pending, and a start without a click is not stopped', () => {
    const stops = new PendingStartStop<object>()
    expect(stops.request()).toBe(false)
    const start = {}
    stops.begin(start)
    expect(stops.settle(start)).toBe(false)
  })

  it('never hands a stop to a later start, and keeps it for the start it was clicked during', () => {
    const stops = new PendingStartStop<object>()
    const first = {}
    const second = {}
    stops.begin(first)
    stops.request()
    stops.begin(second)
    expect(stops.settle(second)).toBe(false)
    expect(stops.settle(first)).toBe(true)
  })

  it('keeps the stop for its own start when an older start settles late', () => {
    const stops = new PendingStartStop<object>()
    const older = {}
    const current = {}
    stops.begin(older)
    stops.begin(current)
    stops.request()
    expect(stops.settle(older)).toBe(false)
    expect(stops.settle(current)).toBe(true)
  })
})
