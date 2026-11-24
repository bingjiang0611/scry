import { describe, expect, it } from 'vitest'
import { hostQueueEntries, isAgentQueueEntry, type HostQueueRow } from './host-queue'

const row = (overrides: Partial<HostQueueRow> = {}): HostQueueRow => ({
  runId: 'run-1', sessionKey: 's-1', lifecycle: 'queued', queuePosition: 1, intentSeq: 1, ...overrides
})

// D1: one queue, read the same way on every client. Order is the host's slot, ties break on the
// intent sequence, and a held entry stays in the queue because it is still waiting.
describe('host queue', () => {
  it('keeps only queued rows of the requested session', () => {
    const entries = hostQueueEntries([
      row({ runId: 'a', queuePosition: 1 }),
      row({ runId: 'b', lifecycle: 'dispatched', queuePosition: 2 }),
      row({ runId: 'c', sessionKey: 's-2', queuePosition: 1 })
    ], 's-1')
    expect(entries.map((entry) => entry.runId)).toEqual(['a'])
  })

  it('orders by the host slot and breaks ties by intent sequence', () => {
    const entries = hostQueueEntries([
      row({ runId: 'third', queuePosition: 3, intentSeq: 3 }),
      row({ runId: 'second', queuePosition: 2, intentSeq: 2 }),
      row({ runId: 'first', queuePosition: 2, intentSeq: 1 })
    ])
    expect(entries.map((entry) => entry.runId)).toEqual(['first', 'second', 'third'])
    expect(entries[0].position).toBe(2)
  })

  it('falls back to the arrival order when the host did not report a slot', () => {
    const entries = hostQueueEntries([
      row({ runId: 'later', queuePosition: null, intentSeq: 9 }),
      row({ runId: 'earlier', queuePosition: null, intentSeq: 4 })
    ])
    expect(entries.map((entry) => entry.runId)).toEqual(['earlier', 'later'])
    expect(entries.map((entry) => entry.position)).toEqual([1, 2])
  })

  it('keeps a held entry in the queue and marks it held', () => {
    const entries = hostQueueEntries([row({ runId: 'held', queueHeld: true })])
    expect(entries).toEqual([{ runId: 'held', position: 1, held: true, promptPreview: null, origin: null }])
  })

  it('tells an agent wake apart from the user own message', () => {
    expect(isAgentQueueEntry({ runId: 'x', position: 1, held: false, promptPreview: null, origin: 'agent' })).toBe(true)
    expect(isAgentQueueEntry({ runId: 'x', position: 1, held: false, promptPreview: null, origin: 'user' })).toBe(false)
  })
})
