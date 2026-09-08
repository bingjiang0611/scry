import { mcpCallsForEvent, type TraceEvent } from '@shared/trace'
import { aggregateCalls, logicalCallEventsForTurn, type Turn } from './format'
import { isInferredSkillLoad } from './skill-load-evidence'

export interface SessionCapabilityCall {
  key: string
  kind: 'skill' | 'mcp'
  name: string
  count: number
  inferredCount?: number
  event: TraceEvent
  runId: string
}

/** Loaded session evidence only: never intersect with today's configured/enabled inventory. */
export function sessionCapabilityCalls(turns: readonly Turn[]): SessionCapabilityCall[] {
  // Dedup within each turn: IDs may be reused in a later turn. Use the same logical-call
  // projection as Overview (results, repeated progress and file-only Skill references don't count).
  const scoped = turns.flatMap((turn) => logicalCallEventsForTurn(turn.items, turn.userText)
    .filter((event) => event.stage !== 'tool_result')
    .map((event) => ({ event, runId: turn.runId })))
  const calls = aggregateCalls(scoped.map(({ event }) => event))
  const rows: SessionCapabilityCall[] = []
  for (const skill of calls.skills) {
    const first = scoped.find(({ event }) => event.kind === 'skill' && (event.name ?? 'skill') === skill.name)
    if (first) rows.push({
      key: `skill:${skill.name}`, kind: 'skill', name: skill.name, count: skill.count,
      inferredCount: scoped.filter(({ event }) => event.name === skill.name && isInferredSkillLoad(event)).length,
      ...first,
      event: isInferredSkillLoad(first.event)
        ? turns.find((turn) => turn.runId === first.runId)?.items.find((event) => event.id === first.event.id) ?? first.event
        : first.event
    })
  }
  for (const server of calls.mcp) {
    for (const action of server.actions) {
      const first = scoped.find(({ event }) => event.kind === 'tool' && event.isMcp &&
        mcpCallsForEvent(event).some((ref) => ref.server === server.server && ref.tool === action.tool))
      if (first) rows.push({
        key: JSON.stringify(['mcp', server.server, action.tool]),
        kind: 'mcp',
        name: `${server.server} / ${action.action || action.tool}`,
        count: action.count,
        ...first
      })
    }
  }
  return rows
}
