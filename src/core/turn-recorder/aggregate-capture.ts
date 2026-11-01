import type { TraceEvent } from '../../shared/trace.js'

type CaptureField = 'assistant_response' | 'tool_input' | 'tool_response' | 'model_segments' | 'error'

export function captureOmissionReasons(events: TraceEvent[], fields: CaptureField[]): string[] {
  const reasons = new Set<string>()
  for (const event of events) {
    const limitations = event.runtimeMetadata?.scryCaptureLimitations
    if (!Array.isArray(limitations)) continue
    for (const raw of limitations) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const item = raw as Record<string, unknown>
      if (!fields.includes(item.field as CaptureField)) continue
      const label = item.field === 'assistant_response'
        ? 'assistant response'
        : item.field === 'model_segments'
          ? 'model segments'
          : item.field === 'tool_input'
            ? 'tool input'
            : 'tool response'
      const reason = item.reason === 'byte_limit'
        ? 'exceeded the integration byte limit'
        : item.reason === 'item_limit'
          ? 'exceeded the integration item limit'
          : 'could not be serialized by the integration'
      reasons.add(`${label} ${reason}`)
    }
  }
  return [...reasons]
}

export function joinOmissionReasons(reasons: Array<string | undefined>): string | undefined {
  const unique = [...new Set(reasons.filter((reason): reason is string => !!reason))]
  return unique.length > 0 ? unique.join('; ') : undefined
}
