import type { TraceEvent } from './trace.js'

export function isOverviewToolErrorEvent(event: TraceEvent): boolean {
  return event.stage === 'tool_result' && event.isError === true
}

function skillSource(event: TraceEvent): string | undefined {
  const input = event.input as Record<string, unknown> | undefined
  return typeof input?.source === 'string' ? input.source : undefined
}

export function isSkillReferenceEvidence(event: TraceEvent): boolean {
  const source = skillSource(event)
  return source === 'skill_file' || source === 'skill_path_in_bash' || source === 'skill_path_in_command'
}

// Skill trace 同时承载真实调用、注入和文件路径引用。调用统计只接受 Provider 明确调用
// 或 Skill 注入；单纯读取、diff、git show 中出现路径仍保留为推断证据，但不能冒充执行。
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
    const direct = events.filter((event) => skillSource(event) !== 'skill_injection' && !isSkillReferenceEvidence(event))
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
    const injected = events.find((event) => skillSource(event) === 'skill_injection')
    if (injected) kept.add(injected)
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
