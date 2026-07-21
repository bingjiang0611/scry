import type { TraceEvent } from '../shared/trace'

export function appendCoalescedTrace(items: TraceEvent[], event: TraceEvent): void {
  const previous = items[items.length - 1]
  const mergeText =
    previous?.kind === 'model' &&
    event.kind === 'model' &&
    (previous.stage === 'text' || previous.stage === 'text_delta') &&
    (event.stage === 'text' || event.stage === 'text_delta')
  const mergeThinking = previous?.kind === 'model' && event.kind === 'model' && previous.stage === 'thinking' && event.stage === 'thinking'
  if (mergeText) previous.text = `${previous.text ?? ''}${event.text ?? ''}`
  else if (mergeThinking) previous.thinking = `${previous.thinking ?? ''}${event.thinking ?? ''}`
  else items.push({ ...event })
}
