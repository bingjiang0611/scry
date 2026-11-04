import { describe, expect, it } from 'vitest'
import type { ActiveRun, TraceEvent } from '../../shared/trace'
import type { DesktopRemoteTraceRead } from '../../shared/desktop-remote'
import { appendCoalescedTrace, projectionStamp, replaceTraceById, stampProjection } from '../live-trace'
import { mergeRemoteTrace, type RemoteTraceView } from '../../renderer/remote-trace'
import { DockBadgeState } from '../dock-badge'
import { createTraceRuntime } from '../bootstrap/trace-runtime'
import { createTraceRevisions } from './desktop-trace-delta'

// Negative controls for the private projection stamp: the only thing damaged here is the stamp's
// version / dirty evidence. Everything else — the writers, the projection cache, the store's public
// revision rules — stays real. A damaged stamp must hide a patch that a full-content read of the
// same projected array still shows, and the healthy leg of the same sequence must not.
const RUN = 'run-control-1'
let seq = 0
const runtime = () => createTraceRuntime({
  getWindow: () => null,
  rendererCanReceive: () => false,
  activeRunSessionKey: () => null,
  dockBadge: new DockBadgeState(() => { }),
  mainEventId: (prefix, runId) => `${prefix}:${runId}:${++seq}`
})
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
const meta = { runId: RUN, userText: 'task', done: false }
const textDelta = (id: string, text: string): TraceEvent => ({
  id, ts: 'T', runId: RUN, kind: 'model', stage: 'text_delta', text, messageId: 'm-1'
})
const toolResult = (id: string, body: string): TraceEvent => ({
  id, ts: 'T', runId: RUN, kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: id, output: body
})

type Store = ReturnType<typeof createTraceRevisions>
type Session = { trace: ReturnType<typeof runtime>; state: ActiveRun; store: Store; view: RemoteTraceView | null }
const session = (): Session => ({
  trace: runtime(),
  state: { runId: RUN, providerId: 'claude', userText: 'task', items: [], done: false },
  store: createTraceRevisions(),
  view: null
})

function peerRead(store: Store, items: readonly TraceEvent[], view: RemoteTraceView | null): DesktopRemoteTraceRead {
  const snapshot = wire(items) as TraceEvent[]
  const answer = store.observe(RUN, items, view?.cursor)
  if (answer.reset) return { kind: 'snapshot', run: { ...meta, items: snapshot }, cursor: { revision: answer.revision, count: snapshot.length } }
  return { kind: 'delta', run: meta, base: view!.cursor!.revision, cursor: { revision: answer.revision, count: answer.count }, changes: answer.changes.map((index) => ({ index, item: snapshot[index] })) }
}
// One poll: show the projected array to the peer through the store and report what the peer can
// prove. `peerItems` is compared against the projection itself, which is what a full read sends.
function poll(target: Session): { projected: TraceEvent[]; peerItems: TraceEvent[] } {
  const projected = target.trace.boundedLiveRun(target.state).items
  const merged = mergeRemoteTrace(target.view, peerRead(target.store, projected, target.view))
  if (merged.kind === 'gap') throw new Error('unexpected gap')
  target.view = merged.view
  return { projected, peerItems: target.view!.run.items }
}

// Three items, one poll, then an early tool body rewrite: the store can only learn about index 0
// by hashing the suffix again. Returns the projection the store hashed and the rebuilt one.
function seed(target: Session): { before: TraceEvent[]; after: TraceEvent[] } {
  appendCoalescedTrace(target.state.items, textDelta('d-1', 'hello'))
  appendCoalescedTrace(target.state.items, toolResult('t-1', 'aaaa'))
  appendCoalescedTrace(target.state.items, toolResult('t-2', 'second'))
  const before = poll(target).projected
  replaceTraceById(target.state.items, { ...target.state.items[1], output: 'bbbb' })
  const after = target.trace.boundedLiveRun(target.state).items
  expect(after[1].output).toBe('bbbb')
  return { before, after }
}

describe('projection stamp fault controls', () => {
  it('healthy: the rewritten body reaches the peer', () => {
    const target = session()
    seed(target)
    const healthy = poll(target)
    expect(wire(healthy.peerItems)).toEqual(wire(healthy.projected))
    expect(healthy.peerItems[1].output).toBe('bbbb')
  })

  it('stale version evidence makes the peer keep the old body', () => {
    const target = session()
    const { before, after } = seed(target)
    const healthy = projectionStamp(before)!
    const damaged = projectionStamp(after)!
    // Damage only the numbers the store trusts: claim this projection is still the one it already
    // hashed, without changing the generation token or anything the peer can see.
    stampProjection(after, { ...damaged, revision: healthy.revision, baseRevision: healthy.baseRevision })
    expect(projectionStamp(after)!.generation).toBe(damaged.generation)
    const control = poll(target)
    expect(wire(control.peerItems)).not.toEqual(wire(control.projected))
    expect(control.peerItems[1].output).toBe('aaaa')
  })

  it('a dirty start past the patched index makes the peer keep the old body', () => {
    const target = session()
    const { before, after } = seed(target)
    const healthy = projectionStamp(before)!
    const damaged = projectionStamp(after)!
    // Same continuous revision, but the recorded start hides the real write.
    stampProjection(after, { ...damaged, baseRevision: healthy.revision, dirtyFrom: after.length + 1 })
    expect(projectionStamp(after)!.generation).toBe(damaged.generation)
    const control = poll(target)
    expect(wire(control.peerItems)).not.toEqual(wire(control.projected))
    expect(control.peerItems[1].output).toBe('aaaa')
    // The next honest projection recovers: real evidence hashes the suffix again.
    replaceTraceById(target.state.items, { ...target.state.items[1], output: 'cccc' })
    const recovered = poll(target)
    expect(wire(recovered.peerItems)).toEqual(wire(recovered.projected))
    expect(recovered.peerItems[1].output).toBe('cccc')
  })
})
