import { describe, expect, it } from 'vitest'
import { hostQueueItems } from './host-queue-model'
import { HOST_QUEUE_COPY } from '../constants/host-queue-copy'

// D1: the renderer shows the host's queue, so it must not renumber or re-sort it. What it adds is
// only what the host cannot say for itself: which entries are held open and which came from an agent.
describe('hostQueueItems', () => {
  it('keeps the host order and position and shows the prompt preview', () => {
    const items = hostQueueItems([
      { runId: 'b', position: 2, held: false, promptPreview: '第二条', origin: 'user' },
      { runId: 'a', position: 1, held: false, promptPreview: '第一条', origin: 'user' }
    ])
    expect(items.map((item) => item.runId)).toEqual(['b', 'a'])
    expect(items[0].positionLabel).toBe(HOST_QUEUE_COPY.position(2))
  })

  it('says a held entry will not send itself and marks an agent origin', () => {
    const [held] = hostQueueItems([{ runId: 'a', position: 1, held: true, promptPreview: null, origin: 'agent' }])
    expect(held.note).toBe(`${HOST_QUEUE_COPY.held} · ${HOST_QUEUE_COPY.fromAgent}`)
    expect(held.text).toBe(HOST_QUEUE_COPY.noPrompt)
  })

  it('leaves the note empty when the entry is neither held nor from an agent', () => {
    const [plain] = hostQueueItems([{ runId: 'a', position: 3, held: false, promptPreview: 'go', origin: 'user' }])
    expect(plain.note).toBeNull()
  })
})
