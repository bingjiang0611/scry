import type { TraceEvent } from '../shared/trace'
import type { DesktopRemoteTraceRead } from '../shared/desktop-remote'
import { appendedText } from './daemon-run-evidence'

// What one trace read means for the renderer.
//
// The daemon answers with a whole snapshot or with a delta, and the difference matters:
// a growing text block is an append to the item the renderer holds, while anything that
// rewrites history must not be replayed as if it were new. This is the decision, kept
// apart from the polling so it can be read (and tested) on its own.

export interface DeliveryPlan {
  // Events to hand the renderer, in the order it should apply them.
  events: TraceEvent[]
  // The item delivered at each index after this read.
  pushed: TraceEvent[]
  // Set when the renderer's copy no longer matches: it must re-read a snapshot.
  resyncRequired: boolean
}

export function planDelivery(pushed: TraceEvent[], read: DesktopRemoteTraceRead): DeliveryPlan {
  if (read.kind === 'snapshot') {
    const items = read.run?.items ?? []
    // The first snapshot of a run this window just started is the whole history: deliver
    // it, then only the appended tail from then on.
    const fresh = items.slice(pushed.length)
    // A snapshot can also carry growth of an item the renderer already holds - the first
    // read after a quiet poll often is one - and replacing it silently would drop the
    // rest of the message. Deliver the growth first, then the new items.
    const grown: TraceEvent[] = []
    const next = [...items]
    for (let index = 0; index < pushed.length && index < items.length; index++) {
      const item = items[index]
      const tail = item ? appendedText(pushed[index], item) : undefined
      if (tail === undefined) continue
      grown.push({ ...item, id: `${item.id}#${tail.at}`, stage: 'text_delta', text: tail.text })
      next[index] = item
    }
    return { events: [...grown, ...fresh], pushed: next, resyncRequired: false }
  }
  // A delta only appends when every change lands at or after what the renderer already
  // holds. Anything else rewrites history and is not replayed as an append.
  const events: TraceEvent[] = []
  const next = [...pushed]
  let resyncRequired = false
  for (const change of [...read.changes].sort((a, b) => a.index - b.index)) {
    const tail = appendedText(next[change.index], change.item)
    if (tail !== undefined) {
      // Same event, longer text: the renderer appends the tail to the block it holds.
      events.push({ ...change.item, id: `${change.item.id}#${tail.at}`, stage: 'text_delta', text: tail.text })
      next[change.index] = change.item
      continue
    }
    if (change.index < next.length) {
      // A different event at an index the renderer already has: its copy is stale.
      resyncRequired = true
      continue
    }
    events.push(change.item)
    next[change.index] = change.item
  }
  return { events, pushed: next, resyncRequired }
}
