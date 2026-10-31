import type { TraceEvent } from '../shared/trace'

/**
 * Weak per-array mutation state: three numbers, no events, no history, no registry.
 *
 * The array identity is the generation. A writer that hands over a new array gets a fresh
 * state, so anything cached against the old array is dropped instead of being reused.
 */
export interface TraceMutationState {
  /** Increments on every recorded write; a private counter, never sent to a peer. */
  readonly revision: number
  /** Revision at which the pending dirty range starts. */
  readonly baseRevision: number
  /** Earliest index changed since `baseRevision`; infinity when nothing is pending. */
  readonly dirtyFrom: number
}

interface MutableMutationState { revision: number; baseRevision: number; dirtyFrom: number }

const mutationStates = new WeakMap<readonly TraceEvent[], MutableMutationState>()

/** Absent until a writer records something: an array nothing has written to is untracked. */
export function traceMutationState(items: readonly TraceEvent[]): TraceMutationState | undefined {
  return mutationStates.get(items)
}

/**
 * Records a real write at `index`. The writers below call this themselves: a caller-side
 * registration would miss every consumer that ignores a return value (the frozen P0 workload
 * is one). A missing call is an implementation bug — an in-place nested edit cannot be
 * detected afterwards — so tracking is never assumed to be complete.
 */
export function markTraceMutation(items: TraceEvent[], index: number): void {
  let state = mutationStates.get(items)
  if (!state) {
    state = { revision: 0, baseRevision: 0, dirtyFrom: Number.POSITIVE_INFINITY }
    mutationStates.set(items, state)
  }
  state.revision += 1
  if (index < state.dirtyFrom) state.dirtyFrom = index
}

/**
 * Marks every recorded change up to the current revision as consumed. A reader that has not
 * consumed the same range must rebuild from index 0 instead of trusting `dirtyFrom`, which
 * another reader already cleared.
 */
export function consumeTraceMutations(items: readonly TraceEvent[]): void {
  const state = mutationStates.get(items)
  if (!state) return
  state.baseRevision = state.revision
  state.dirtyFrom = Number.POSITIVE_INFINITY
}

/**
 * Evidence attached to a projected array this process built, so the revision store can reuse the
 * hashes of the part that provably did not change. It holds numbers plus one opaque token: no raw
 * or projected arrays, no run ids, and it is never an IPC field a renderer or peer could forge.
 */
export interface ProjectionStamp {
  /** Opaque per cache entry: equal only while the same projection generation produced both. */
  readonly generation: object
  /** Raw mutation revision this projection was built from. */
  readonly revision: number
  /** Revision the previous projection of this generation was built from; null if unknown. */
  readonly baseRevision: number | null
  /** First index that was actually re-projected. */
  readonly dirtyFrom: number
}

const projectionStamps = new WeakMap<readonly TraceEvent[], ProjectionStamp>()

export function stampProjection(items: readonly TraceEvent[], stamp: ProjectionStamp): void {
  projectionStamps.set(items, stamp)
}

export function projectionStamp(items: readonly TraceEvent[]): ProjectionStamp | undefined {
  return projectionStamps.get(items)
}

/**
 * 按 id 原地替换或追加。运行中 Diff 预览用固定 id 反复发布，必须替换而不是堆积
 * （renderer 的 applyTraceBatch 对同 id 事件同样是原地替换，两侧语义一致）。
 */
export function upsertTraceById(items: TraceEvent[], event: TraceEvent): void {
  const index = items.findIndex((candidate) => candidate.id === event.id)
  if (index >= 0) items[index] = { ...event }
  else items.push({ ...event })
  markTraceMutation(items, index >= 0 ? index : items.length - 1)
}

/**
 * Replaces an already appended event with the same id (persisted content enrichment) and
 * reports whether it still existed. A removed event stays removed: this never restores one.
 * The index is looked up by id, so a splice between enqueue and persist cannot misplace it.
 */
export function replaceTraceById(items: TraceEvent[], event: TraceEvent): boolean {
  const index = items.findIndex((candidate) => candidate.id === event.id)
  if (index < 0) return false
  items[index] = event
  markTraceMutation(items, index)
  return true
}

export function appendCoalescedTrace(items: TraceEvent[], event: TraceEvent): void {
  if (
    event.kind === 'model' && event.stage === 'text' &&
    event.runtimeMetadata?.replacesStreamedText === true && event.messageId
  ) {
    const first = items.findIndex((candidate) =>
      candidate.kind === 'model' &&
      (candidate.stage === 'text' || candidate.stage === 'text_delta') &&
      candidate.messageId === event.messageId &&
      candidate.agentId === event.agentId &&
      candidate.parentToolUseId === event.parentToolUseId
    )
    if (first >= 0) {
      for (let index = items.length - 1; index >= first; index--) {
        const candidate = items[index]
        if (
          candidate.kind === 'model' &&
          (candidate.stage === 'text' || candidate.stage === 'text_delta') &&
          candidate.messageId === event.messageId &&
          candidate.agentId === event.agentId &&
          candidate.parentToolUseId === event.parentToolUseId
        ) items.splice(index, 1)
      }
      items.splice(first, 0, { ...event })
      markTraceMutation(items, first)
      return
    }
  }
  const previous = items[items.length - 1]
  const sameModelStream =
    previous?.messageId === event.messageId &&
    previous?.agentId === event.agentId &&
    previous?.parentToolUseId === event.parentToolUseId
  const mergeText =
    previous?.kind === 'model' &&
    event.kind === 'model' &&
    previous.stage === event.stage &&
    (event.stage === 'text' || event.stage === 'text_delta') &&
    sameModelStream
  const mergeThinking =
    previous?.kind === 'model' &&
    event.kind === 'model' &&
    previous.stage === 'thinking' &&
    event.stage === 'thinking' &&
    sameModelStream
  if (mergeText) previous.text = `${previous.text ?? ''}${event.text ?? ''}`
  else if (mergeThinking) previous.thinking = `${previous.thinking ?? ''}${event.thinking ?? ''}`
  else items.push({ ...event })
  if ((mergeText || mergeThinking) && event.llmPerformance) previous.llmPerformance = event.llmPerformance
  markTraceMutation(items, items.length - 1)
}
