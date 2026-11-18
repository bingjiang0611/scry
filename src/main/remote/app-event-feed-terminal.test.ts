import { describe, expect, it } from 'vitest'
import { AppEventFeed } from './app-event-feed'

// P3-terminal: the feed tells the App that terminal output is waiting (one notice stands
// for any number of chunks), and says how long it has gone unread, which is how the
// daemon knows its App is gone and its shells must not outlive it.

describe('AppEventFeed terminal notices and idle time', () => {
  it('keeps one terminal notice however many times output arrives', async () => {
    const feed = new AppEventFeed({ epoch: 'e' })
    const start = await feed.read({ cursor: 0, waitMs: 0 })
    feed.append({ kind: 'terminal' })
    feed.append({ kind: 'terminal' })
    const read = await feed.read({ epoch: 'e', cursor: start.cursor, waitMs: 0 })
    expect(read.items).toEqual([{ kind: 'terminal' }])
  })

  it('measures idle time from the last read, on the clock it is given', async () => {
    let now = 1_000
    const feed = new AppEventFeed({ epoch: 'e', now: () => now })
    now = 61_000
    expect(feed.idleMs()).toBe(60_000)
    await feed.read({ cursor: 0, waitMs: 0 })
    expect(feed.idleMs()).toBe(0)
    // A read that is still waiting counts as being read: the App is there.
    const waiting = feed.read({ epoch: 'e', cursor: 0, waitMs: 50 })
    now = 200_000
    expect(feed.idleMs()).toBe(0)
    await waiting
    now = 230_000
    expect(feed.idleMs()).toBe(30_000)
  })
})
