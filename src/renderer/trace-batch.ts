import type { TraceEvent } from '@shared/trace'
import type { Turn } from './format-types'
import { recordTraceItemsChange } from './turn-stream-projection'

// 性能：把一批 onTrace 事件一次性合并进 turns（替代每事件一次 setState）。FIFO 保序、按 id 去重、
// 连续 text_delta / thinking 流片段合并进上一条——语义与逐事件版完全一致，只是批量。
// clone-on-write 只复制变动的 turn。
// Renderer snapshots are immutable. Weak keys let old histories be collected;
// copy indices only when identities change, not on each text/thinking fragment.
const traceTurnIndices = new WeakMap<Turn[], Map<string, number>>()
const traceEventIndices = new WeakMap<TraceEvent[], Map<string, number>>()

export function applyTraceBatch(prev: Turn[], events: TraceEvent[], cleared: Set<string>): Turn[] {
  if (events.length === 0) return prev
  let next = prev
  let turnIndices = traceTurnIndices.get(prev)
  if (!turnIndices) {
    turnIndices = new Map(prev.map((turn, index) => [turn.runId, index]))
    traceTurnIndices.set(prev, turnIndices)
  }
  let turnIndicesMutable = false
  const states = new Map<number, {
    items: TraceEvent[]; indices: Map<string, number>; mutable: boolean; indicesMutable: boolean
    previous: TraceEvent[]; firstChanged: number
  }>()
  const stateFor = (index: number) => {
    let state = states.get(index)
    if (!state) {
      const items = next[index].items
      let indices = traceEventIndices.get(items)
      if (!indices) {
        indices = new Map(items.map((event, itemIndex) => [event.id, itemIndex]))
        traceEventIndices.set(items, indices)
      }
      state = { items, indices, mutable: false, indicesMutable: false, previous: items, firstChanged: items.length }
      states.set(index, state)
    }
    return state
  }
  const mutableStateFor = (index: number, firstChanged: number) => {
    const state = stateFor(index)
    state.firstChanged = Math.min(state.firstChanged, firstChanged)
    if (state.mutable) return state
    if (next === prev) next = [...prev]
    state.items = [...state.items]
    state.mutable = true
    next[index] = { ...next[index], items: state.items }
    return state
  }
  const rebuildIndices = (state: ReturnType<typeof stateFor>) => {
    state.indices = new Map(state.items.map((event, itemIndex) => [event.id, itemIndex]))
    state.indicesMutable = true
  }

  for (const ev of events) {
    if (cleared.has(ev.runId)) continue
    let index = turnIndices.get(ev.runId)
    if (index == null) {
      if (next === prev) next = [...prev]
      index = next.length
      const items = [ev]
      next.push({ runId: ev.runId, userText: '', items, done: false })
      if (!turnIndicesMutable) {
        turnIndices = new Map(turnIndices)
        turnIndicesMutable = true
      }
      turnIndices.set(ev.runId, index)
      states.set(index, { items, indices: new Map([[ev.id, 0]]), mutable: true, indicesMutable: true,
        previous: items, firstChanged: 0 })
      continue
    }

    let state = stateFor(index)
    const existingIndex = state.indices.get(ev.id)
    if (ev.kind === 'harness' && ev.stage === 'result_superseded') {
      if (existingIndex == null) continue
      state = mutableStateFor(index, existingIndex)
      state.items.splice(existingIndex, 1)
      rebuildIndices(state)
      continue
    }
    if (existingIndex != null) {
      if (state.items[existingIndex] === ev) continue
      state = mutableStateFor(index, existingIndex)
      state.items[existingIndex] = ev
      continue
    }
    if (
      ev.kind === 'model' && ev.stage === 'text' &&
      ev.runtimeMetadata?.replacesStreamedText === true && ev.messageId
    ) {
      const first = state.items.findIndex((candidate) =>
        candidate.kind === 'model' &&
        (candidate.stage === 'text' || candidate.stage === 'text_delta') &&
        candidate.messageId === ev.messageId &&
        candidate.agentId === ev.agentId &&
        candidate.parentToolUseId === ev.parentToolUseId
      )
      if (first >= 0) {
        state = mutableStateFor(index, first)
        state.items = state.items.filter((candidate) => !(
          candidate.kind === 'model' &&
          (candidate.stage === 'text' || candidate.stage === 'text_delta') &&
          candidate.messageId === ev.messageId &&
          candidate.agentId === ev.agentId &&
          candidate.parentToolUseId === ev.parentToolUseId
        ))
        state.items.splice(first, 0, ev)
        next[index] = { ...next[index], items: state.items }
        rebuildIndices(state)
        continue
      }
    }

    // Conservatively include the last event: text/thinking may be coalesced into it.
    state = mutableStateFor(index, Math.max(0, state.items.length - 1))
    const lastIndex = state.items.length - 1
    const last = state.items[lastIndex]
    const sameModelStream =
      last?.kind === 'model' && ev.kind === 'model' &&
      ev.messageId === last.messageId && ev.agentId === last.agentId &&
      ev.parentToolUseId === last.parentToolUseId
    if (ev.stage === 'text_delta' && last?.stage === 'text_delta' && sameModelStream) {
      state.items[lastIndex] = { ...last, text: (last.text ?? '') + (ev.text ?? ''), llmPerformance: ev.llmPerformance ?? last.llmPerformance }
    } else if (ev.stage === 'thinking' && last?.stage === 'thinking' && sameModelStream) {
      state.items[lastIndex] = { ...last, thinking: (last.thinking ?? '') + (ev.thinking ?? ''), llmPerformance: ev.llmPerformance ?? last.llmPerformance }
    } else {
      if (!state.indicesMutable) {
        state.indices = new Map(state.indices)
        state.indicesMutable = true
      }
      state.indices.set(ev.id, state.items.length)
      state.items.push(ev)
    }
  }
  traceTurnIndices.set(next, turnIndices)
  for (const state of states.values()) {
    if (state.mutable) {
      traceEventIndices.set(state.items, state.indices)
      if (state.items !== state.previous) recordTraceItemsChange(state.items, state.previous, state.firstChanged)
    }
  }
  return next
}
