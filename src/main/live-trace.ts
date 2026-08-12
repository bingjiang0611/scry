import type { TraceEvent } from '../shared/trace'

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
}
