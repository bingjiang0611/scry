import type { TraceEvent } from './trace.js'

export function isOverviewToolErrorEvent(event: TraceEvent): boolean {
  return event.stage === 'tool_result' && event.isError === true
}

function skillSource(event: TraceEvent): string | undefined {
  const input = event.input as Record<string, unknown> | undefined
  return typeof input?.source === 'string' ? input.source : undefined
}

function isSkillPathEvidence(event: TraceEvent): boolean {
  const source = skillSource(event)
  return source === 'skill_file' || source === 'skill_path_in_bash' || source === 'skill_path_in_command'
}

// Skill trace 同时承载真实调用、注入和内部文件路径证据。所有记录与 UI 统计必须先走
// 同一套去重，避免同一轮在本地记录、上传看板和 Scry 纵览里出现不同计数。
export function logicalCallEventsForTurn(items: TraceEvent[]): TraceEvent[] {
  const skillEvents = new Map<string, TraceEvent[]>()
  for (const event of items) {
    if (event.kind !== 'skill' || event.stage === 'tool_result') continue
    const name = event.name ?? 'Skill'
    const events = skillEvents.get(name)
    if (events) events.push(event)
    else skillEvents.set(name, [event])
  }

  const kept = new Set<TraceEvent>()
  for (const events of skillEvents.values()) {
    const direct = events.filter((event) => skillSource(event) !== 'skill_injection' && !isSkillPathEvidence(event))
    if (direct.length > 0) {
      const identities = new Set<string>()
      for (const event of direct) {
        const identity = event.toolUseId
          ? `tool:${event.toolUseId}`
          : event.messageId
            ? `message:${event.messageId}`
            : 'anonymous'
        if (identities.has(identity)) continue
        identities.add(identity)
        kept.add(event)
      }
      continue
    }
    kept.add(events.find((event) => skillSource(event) === 'skill_injection') ?? events[0])
  }

  const callIdentities = new Set<string>()
  return items.filter((event) => {
    if (event.kind === 'skill') return event.stage === 'tool_result' || kept.has(event)
    if (event.stage === 'tool_result' || (event.kind !== 'tool' && event.kind !== 'agent')) return true
    if (!event.toolUseId) return true
    const identity = `${event.kind}:${event.toolUseId}`
    if (callIdentities.has(identity)) return false
    callIdentities.add(identity)
    return true
  })
}
