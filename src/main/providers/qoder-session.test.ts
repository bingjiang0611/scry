import { describe, expect, it, vi } from 'vitest'
import type { Query } from '@qoder-ai/qoder-agent-sdk'
import { QoderSessionBusyError, createQoderSession, type QoderTurnChannel } from './qoder-session'

/** A fake SDK query: messages are pushed by the test and read by the session's single pump. */
function fakeQuery() {
  const queue: Record<string, unknown>[] = []
  let wake: (() => void) | undefined
  let done = false
  const close = vi.fn(async () => { done = true; wake?.() })
  const query = {
    close,
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift()
        if (next) { yield next; continue }
        if (done) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    }
  }
  return {
    query: query as unknown as Query,
    push: (message: Record<string, unknown>) => { queue.push(message); wake?.(); wake = undefined },
    close
  }
}

const collect = async (turn: QoderTurnChannel, count: number): Promise<unknown[]> => {
  const seen: unknown[] = []
  for await (const message of turn) {
    seen.push(message)
    if (seen.length === count) break
  }
  return seen
}

// C1: the SDK iterator is consumed once for the session's life, so turns must share it in order and a
// settled turn must hand the reader over instead of leaving it parked.
describe('Qoder kept session', () => {
  it('routes one message stream to consecutive turns in order', async () => {
    const fake = fakeQuery()
    const session = createQoderSession(fake.query)
    const first = session.beginTurn()
    fake.push({ type: 'system', subtype: 'init' })
    fake.push({ type: 'result', subtype: 'success' })
    expect(await collect(first, 2)).toEqual([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success' }
    ])
    first.end()

    const second = session.beginTurn()
    fake.push({ type: 'assistant', session_id: 'qoder-2' })
    expect(await collect(second, 1)).toEqual([{ type: 'assistant', session_id: 'qoder-2' }])
    second.end()
    await session.close()
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('keeps messages that arrive between turns for the next turn', async () => {
    const fake = fakeQuery()
    const session = createQoderSession(fake.query)
    fake.push({ type: 'late-result' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const turn = session.beginTurn()
    expect(await collect(turn, 1)).toEqual([{ type: 'late-result' }])
    turn.end()
    await session.close()
  })

  it('refuses a second reader and ends a turn without closing the session', async () => {
    const fake = fakeQuery()
    const session = createQoderSession(fake.query)
    const turn = session.beginTurn()
    const iterator = turn[Symbol.asyncIterator]()
    // Park the first reader, then prove a second one is refused rather than interleaving.
    const first = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(turn[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(QoderSessionBusyError)
    fake.push({ type: 'one' })
    expect(await first).toEqual({ value: { type: 'one' }, done: false })
    turn.end()
    expect(session.closed).toBe(false)
    await session.close()
  })

  it('surfaces a failed stream to the waiting turn instead of hanging', async () => {
    const broken = {
      close: vi.fn(async () => {}),
      async *[Symbol.asyncIterator]() { throw new Error('sdk_stream_failed') }
    } as unknown as Query
    const session = createQoderSession(broken)
    const turn = session.beginTurn()
    await expect(collect(turn, 1)).rejects.toThrow('sdk_stream_failed')
    turn.end()
    await session.close()
  })
})
