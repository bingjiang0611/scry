import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { OrchestrationCommand, SessionCreatePayload, SessionForkPayload } from '../host-runtime/orchestration/orchestrator-commands'
import type { SessionLineage } from '../host-runtime/orchestration/types'

/**
 * D3: forks, side chats and remote forks have to record their lineage in `orchestration.db` as a
 * real event, not only in the conversation file. The row is created by the decision, so the
 * projection and the file describe the same tree; a projection rebuilt from events keeps it.
 *
 * The command is authored by the host (`system`), because no device or peer asked for the row by
 * id: the fork itself already happened and this records which session it came from.
 */
export interface SessionLineageInput {
  /** Native session id of the session that now exists. */
  sessionKey: string
  parentSessionKey: string
  rootSessionKey?: string
  conversationId?: string | null
  provider?: string | null
  profile?: string | null
  cwd?: string | null
  title?: string | null
  lineage: SessionLineage
}

export interface SessionLineageResult {
  status: 'recorded' | 'unavailable'
  reason?: string
}

const ACTOR = 'system'

function forkCommand(commandId: string, payload: SessionForkPayload): OrchestrationCommand {
  return { type: 'session.fork', commandId, actor: ACTOR, scope: 'system', at: 0,
    payload, payloadSha256: sha256Hex(canonicalJson(payload)) }
}

function createCommand(commandId: string, payload: SessionCreatePayload): OrchestrationCommand {
  return { type: 'session.create', commandId, actor: ACTOR, scope: 'system', at: 0,
    payload, payloadSha256: sha256Hex(canonicalJson(payload)) }
}

function commandFor(input: SessionLineageInput): OrchestrationCommand {
  const commandId = `lineage:${input.sessionKey}:${input.lineage.kind}`
  if (input.lineage.kind === 'fork') {
    const payload = {
      sessionKey: input.sessionKey,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.title ? { title: input.title } : {}),
      parentSessionKey: input.parentSessionKey,
      rootSessionKey: input.rootSessionKey ?? input.parentSessionKey,
      lineage: input.lineage
    }
    return forkCommand(commandId, payload as SessionForkPayload)
  }
  const payload = {
    sessionKey: input.sessionKey,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.title ? { title: input.title } : {}),
    parentSessionKey: input.parentSessionKey,
    rootSessionKey: input.rootSessionKey ?? input.parentSessionKey,
    lineage: input.lineage
  }
  return createCommand(commandId, payload as SessionCreatePayload)
}

/** Records the lineage; a store that cannot write says so instead of pretending the row exists. */
export function recordSessionLineage(
  sink: EventSink | undefined,
  input: SessionLineageInput,
  now: number
): SessionLineageResult {
  if (!sink) return { status: 'unavailable', reason: 'orchestration_unavailable' }
  if (sink.isWriteIndeterminate()) return { status: 'unavailable', reason: 'orchestration_write_indeterminate' }
  const built = commandFor(input)
  const result = sink.execute({
    ...built,
    actor: ACTOR,
    scope: 'system',
    at: now
  })
  if (result.kind === 'rejected') return { status: 'unavailable', reason: result.reason }
  return { status: 'recorded' }
}
