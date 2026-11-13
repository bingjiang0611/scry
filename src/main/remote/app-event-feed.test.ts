import { describe, expect, it } from 'vitest'
import { AppEventFeed } from './app-event-feed'

// P3f: what the daemon has to tell its App that no run read carries - a turn recorded,
// a conversation changed, a catalog recovered. Cursor, replay-or-reset and coalescing
// follow t3code's thread subscription; the transport is the App's own long poll.

const conversation = (conversationId: string) => ({ kind: 'data' as const, event: { kind: 'conversation_changed' as const, conversationId } })
const recorded = (runId: string) => ({ kind: 'data' as const, event: { runId, kind: 'turn_recorded' as const } })

describe('App event feed', () => {
  it('starts a new client at the present instead of replaying old events', async () => {
    const feed = new AppEventFeed({ epoch: 'e1' })
    feed.append(recorded('old'))
    await expect(feed.read({ cursor: 0, waitMs: 0 })).resolves.toEqual({ epoch: 'e1', cursor: 1, items: [] })
  })

  it('answers what happened after the cursor, at once when there is something', async () => {
    const feed = new AppEventFeed({ epoch: 'e1' })
    const first = await feed.read({ cursor: 0, waitMs: 0 })
    feed.append(recorded('run-1'))
    feed.append(conversation('c1'))
    const reply = await feed.read({ epoch: 'e1', cursor: first.cursor, waitMs: 10_000 })
    expect(reply).toEqual({ epoch: 'e1', cursor: 2, items: [recorded('run-1'), conversation('c1')] })
    await expect(feed.read({ epoch: 'e1', cursor: reply.cursor, waitMs: 0 })).resolves.toEqual({ epoch: 'e1', cursor: 2, items: [] })
  })

  it('wakes a waiting read on the next event, and ends an idle one at its wait', async () => {
    const feed = new AppEventFeed({ epoch: 'e1' })
    const waiting = feed.read({ epoch: 'e1', cursor: 0, waitMs: 10_000 })
    feed.append(conversation('c1'))
    await expect(waiting).resolves.toMatchObject({ cursor: 1, items: [conversation('c1')] })
    const started = Date.now()
    await expect(feed.read({ epoch: 'e1', cursor: 1, waitMs: 30 })).resolves.toEqual({ epoch: 'e1', cursor: 1, items: [] })
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  it('keeps only the newest notice for one conversation, in its newest position', async () => {
    const feed = new AppEventFeed({ epoch: 'e1' })
    feed.append(conversation('c1'))
    feed.append(recorded('run-1'))
    feed.append(conversation('c1'))
    const reply = await feed.read({ epoch: 'e1', cursor: 0, waitMs: 0 })
    expect(reply.items).toEqual([recorded('run-1'), conversation('c1')])
    expect(reply.cursor).toBe(3)
  })

  it('tells a client to resynchronize after a daemon restart or a lost range, never silently skips', async () => {
    const feed = new AppEventFeed({ epoch: 'e2', maxItems: 2 })
    await expect(feed.read({ epoch: 'e1', cursor: 5, waitMs: 0 })).resolves.toEqual({ epoch: 'e2', cursor: 0, items: [], reset: true })
    for (const runId of ['a', 'b', 'c']) feed.append(recorded(runId))
    // Event 1 fell out of the buffer: a client at cursor 0 missed it.
    await expect(feed.read({ epoch: 'e2', cursor: 0, waitMs: 0 })).resolves.toEqual({ epoch: 'e2', cursor: 3, items: [], reset: true })
    await expect(feed.read({ epoch: 'e2', cursor: 1, waitMs: 0 })).resolves.toEqual({ epoch: 'e2', cursor: 3, items: [recorded('b'), recorded('c')] })
    // A cursor from the future is not this feed's.
    await expect(feed.read({ epoch: 'e2', cursor: 9, waitMs: 0 })).resolves.toMatchObject({ reset: true, cursor: 3 })
  })

  it('bounds retained bytes as well as items', async () => {
    const feed = new AppEventFeed({ epoch: 'e1', maxBytes: 200 })
    for (let index = 0; index < 10; index++) feed.append(conversation(`conversation-${index}`))
    const reply = await feed.read({ epoch: 'e1', cursor: 9, waitMs: 0 })
    expect(reply.items).toEqual([conversation('conversation-9')])
    await expect(feed.read({ epoch: 'e1', cursor: 0, waitMs: 0 })).resolves.toMatchObject({ reset: true })
  })

  it('releases waiting reads when it closes', async () => {
    const feed = new AppEventFeed({ epoch: 'e1' })
    const waiting = feed.read({ epoch: 'e1', cursor: 0, waitMs: 10_000 })
    feed.close()
    await expect(waiting).resolves.toEqual({ epoch: 'e1', cursor: 0, items: [] })
  })

  it('keeps one wake per run, so a streaming run cannot crowd others out of the buffer', async () => {
    const feed = new AppEventFeed({ epoch: 'e1', maxItems: 3 })
    for (let index = 0; index < 50; index++) feed.append({ kind: 'run', runId: 'streaming' })
    feed.append({ kind: 'run', runId: 'quiet' })
    feed.append({ kind: 'run', runId: 'streaming' })
    const reply = await feed.read({ epoch: 'e1', cursor: 0, waitMs: 0 })
    expect(reply).toMatchObject({ items: [{ kind: 'run', runId: 'quiet' }, { kind: 'run', runId: 'streaming' }] })
    expect(reply.reset).toBeUndefined()
  })

  it('hands a new or resynchronizing client the current state, and keeps only the newest change', async () => {
    // E1b: the unread set is state. A client that starts, or that lost notices, needs it
    // as it is now, not the changes it missed.
    let current = { revision: 1, unreadSessionKeys: ['s1'] }
    const attention = () => ({ kind: 'attention' as const, snapshot: current })
    const feed = new AppEventFeed({ epoch: 'e1', maxItems: 2, state: () => [attention()] })
    await expect(feed.read({ cursor: 0, waitMs: 0 })).resolves.toEqual({ epoch: 'e1', cursor: 0, items: [attention()] })
    current = { revision: 2, unreadSessionKeys: [] }
    feed.append(attention())
    current = { revision: 3, unreadSessionKeys: ['s2'] }
    feed.append(attention())
    await expect(feed.read({ epoch: 'e1', cursor: 0, waitMs: 0 })).resolves.toMatchObject({ items: [attention()] })
    for (const runId of ['a', 'b', 'c']) feed.append({ kind: 'run', runId })
    await expect(feed.read({ epoch: 'e1', cursor: 1, waitMs: 0 })).resolves.toEqual({ epoch: 'e1', cursor: 5, items: [attention()], reset: true })
  })
})
