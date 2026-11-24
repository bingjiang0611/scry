import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HostQueuePanel } from './components/chat-view/HostQueuePanel'
import { HOST_QUEUE_COPY } from './constants/host-queue-copy'

// D1: three states a user must be able to tell apart — the host's queue, a queue the host has no
// record of, and a queue that could not be read. Only the first may look like a list.
describe('HostQueuePanel', () => {
  it('renders the host order with position, text and the held note', () => {
    const html = renderToStaticMarkup(<HostQueuePanel state={{ status: 'ready', items: [
      { runId: 'a', position: 1, positionLabel: HOST_QUEUE_COPY.position(1), text: '第一条', note: HOST_QUEUE_COPY.held }
    ] }} />)
    expect(html).toContain('第一条')
    expect(html).toContain(HOST_QUEUE_COPY.position(1))
    expect(html).toContain(HOST_QUEUE_COPY.held)
    expect(html).toContain(HOST_QUEUE_COPY.listLabel(1))
  })

  it('says the queue is unknown instead of showing an empty list', () => {
    const html = renderToStaticMarkup(<HostQueuePanel state={{ status: 'unknown', items: [] }} />)
    expect(html).toContain(HOST_QUEUE_COPY.unknownSession)
    expect(html).toContain(HOST_QUEUE_COPY.unknownHint)
    expect(html).not.toContain('role="list"')
  })

  it('shows the failure reason and renders nothing when idle', () => {
    expect(renderToStaticMarkup(<HostQueuePanel state={{ status: 'unavailable', items: [], reason: 'orchestration_unavailable' }} />))
      .toContain(HOST_QUEUE_COPY.unavailable('orchestration_unavailable'))
    expect(renderToStaticMarkup(<HostQueuePanel state={{ status: 'idle', items: [] }} />)).toBe('')
  })
})
