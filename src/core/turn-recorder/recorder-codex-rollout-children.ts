import { type CodexRolloutIdentity, type ParsedTranscriptTurn, nestedRecord, stringAt } from './recorder-contracts.js'
import { stableHash } from './store.js'

type ToolIds = Map<string, string>

export function codexIdentityFromSessionMeta(payload: Record<string, unknown>): CodexRolloutIdentity {
  const source = nestedRecord(payload, 'source')
  const subagent = nestedRecord(source ?? {}, 'subagent')
  const spawn = nestedRecord(subagent ?? {}, 'thread_spawn')
  const parentSessionId = stringAt(payload, 'session_id', 'sessionId')
  const parentThreadId = stringAt(payload, 'parent_thread_id', 'parentThreadId') ?? stringAt(spawn ?? {}, 'parent_thread_id', 'parentThreadId')
  const forkedFromId = stringAt(payload, 'forked_from_id', 'forkedFromId')
  const agentPath = stringAt(payload, 'agent_path', 'agentPath') ?? stringAt(subagent ?? {}, 'agent_path', 'agentPath')
  return {
    sessionId: stringAt(payload, 'id', 'session_id', 'sessionId'),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(forkedFromId ? { forkedFromId } : {}),
    ...(stringAt(payload, 'cwd') ? { cwd: stringAt(payload, 'cwd') } : {}),
    ...(agentPath ? { agentPath } : {}),
    isSubagent: !!(subagent || parentThreadId || forkedFromId)
  }
}

export function recordCodexItemCompleted(
  payload: Record<string, unknown>,
  identity: CodexRolloutIdentity,
  current: ParsedTranscriptTurn,
  toolById: ToolIds,
  runId: string,
  at: string
): void {
  const item = nestedRecord(payload, 'item')
  if (item?.type !== 'SubAgentActivity') return
  const sessionId = stringAt(item, 'agent_thread_id', 'agentThreadId')
  const parentToolUseId = stringAt(item, 'id', 'event_id', 'eventId')
  const name = stringAt(item, 'agent_path', 'agentPath')?.replace(/^\/root\//, '')
  const parentTurnId = stringAt(payload, 'turn_id', 'turnId')
  const sameSession = !!identity.sessionId && stringAt(payload, 'thread_id', 'threadId') === identity.sessionId &&
    parentTurnId === current.providerTurnId
  const trustedParent = !!parentToolUseId && toolById.get(parentToolUseId) === 'Agent'
  if (sessionId && sameSession && trustedParent && !current.childThreads.some((child) => child.sessionId === sessionId)) {
    current.childThreads.push({ sessionId, parentToolUseId, parentTurnId, name })
  }
  if (item.kind === 'started' && sessionId && sameSession && trustedParent &&
    !current.events.some(event => event.kind === 'agent' && event.toolUseId === parentToolUseId)) {
    current.events.push({
      id: `codex-agent-${stableHash([sessionId, parentToolUseId, at]).slice(0, 16)}`,
      ts: at,
      runId,
      kind: 'agent',
      stage: `agent:${name ?? 'subagent'}`,
      tool: 'Agent',
      toolUseId: parentToolUseId,
      agentId: sessionId,
      name: name ?? 'subagent',
      input: { source: 'sub_agent_activity', sessionId }
    })
  }
}

export function recordCodexSubAgentActivity(
  payload: Record<string, unknown>,
  current: ParsedTranscriptTurn,
  toolById: ToolIds,
  runId: string,
  at: string
): void {
  const sessionId = stringAt(payload, 'agent_thread_id', 'agentThreadId')
  const parentToolUseId = stringAt(payload, 'event_id', 'eventId')
  const name = stringAt(payload, 'agent_path', 'agentPath')?.replace(/^\/root\//, '')
  const trustedParent = parentToolUseId && toolById.get(parentToolUseId) === 'Agent'
  if (sessionId && trustedParent && !current.childThreads.some((child) => child.sessionId === sessionId)) {
    current.childThreads.push({ sessionId, parentToolUseId, parentTurnId: current.providerTurnId, name })
  }
  if (payload.kind === 'started' && trustedParent) {
    current.events.push({
      id: `codex-agent-${stableHash([sessionId, parentToolUseId, at]).slice(0, 16)}`,
      ts: at,
      runId,
      kind: 'agent',
      stage: `agent:${name ?? 'subagent'}`,
      tool: 'Agent',
      toolUseId: parentToolUseId,
      agentId: sessionId,
      name: name ?? 'subagent',
      input: { source: 'sub_agent_activity', sessionId }
    })
  }
}
