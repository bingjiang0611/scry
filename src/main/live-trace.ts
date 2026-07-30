import type { TraceEvent } from '../shared/trace'

export function appendCoalescedTrace(items: TraceEvent[], event: TraceEvent): void {
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
