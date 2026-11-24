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

// B3 (review): the copy promises a held entry will not send itself, so the panel has to offer the only
// way it can move. Without this the hold is a dead end the user cannot leave.
describe('host queue panel: releasing a held entry', () => {
  it('offers the action only for a held entry and calls back with its run id', () => {
    const held = { status: 'ready' as const, items: [
      { runId: 'a', position: 1, positionLabel: HOST_QUEUE_COPY.position(1), text: '第一条', note: HOST_QUEUE_COPY.held },
      { runId: 'b', position: 2, positionLabel: HOST_QUEUE_COPY.position(2), text: '第二条', note: null }
    ] }
    const html = renderToStaticMarkup(<HostQueuePanel state={held} onRelease={() => {}} />)
    expect(html).toContain(HOST_QUEUE_COPY.releaseLabel(1))
    expect(html).not.toContain(HOST_QUEUE_COPY.releaseLabel(2))
    expect(html).toContain(HOST_QUEUE_COPY.release)

    // The host refused: the reason is shown instead of a silent no-op.
    const refused = renderToStaticMarkup(<HostQueuePanel state={held} onRelease={() => {}}
      releaseError={HOST_QUEUE_COPY.releaseRefused('illegal_transition')} />)
    expect(refused).toContain(HOST_QUEUE_COPY.releaseRefused('illegal_transition'))
  })

  it('shows the in-flight state and stays read-only with no handler', () => {
    const held = { status: 'ready' as const, items: [
      { runId: 'a', position: 1, positionLabel: HOST_QUEUE_COPY.position(1), text: '第一条', note: HOST_QUEUE_COPY.held }
    ] }
    expect(renderToStaticMarkup(<HostQueuePanel state={held} onRelease={() => {}} releasingRunId="a" />))
      .toContain(HOST_QUEUE_COPY.releasing)
    expect(renderToStaticMarkup(<HostQueuePanel state={held} />)).not.toContain(HOST_QUEUE_COPY.release)
  })
})
