import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { findNativeSession } from '../host-runtime/orchestration/native-session-lookup'
import type { OrchestrationCommand } from '../host-runtime/orchestration/orchestrator-commands'

/**
 * D4: rename, pin and archive used to mutate the catalog file only. Nothing reached the projection,
 * so a device that read the session from the host kept the old title, and no record said who made
 * the change. Each change is now a command decided by the authority, authored by the caller.
 */
export type SessionMetadataChange =
  | { kind: 'rename'; title: string }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'archive'; archived: boolean }

export interface SessionMetadataRef {
  externalSessionId: string
  providerId: string
  agentProfileId?: string | undefined
  cwd: string
}

export interface SessionMetadataResult {
  status: 'recorded' | 'unavailable'
  reason?: string
}

const COMMAND_TYPES = {
  rename: 'session.rename',
  pin: 'session.pin',
  unpin: 'session.unpin',
  archive: 'session.archive',
  restore: 'session.restore'
} as const

function commandFor(
  sessionKey: string,
  cwd: string,
  change: SessionMetadataChange,
  actor: string,
  at: number
): OrchestrationCommand {
  const shape = change.kind === 'rename' ? 'rename'
    : change.kind === 'pin' ? (change.pinned ? 'pin' : 'unpin')
      : (change.archived ? 'archive' : 'restore')
  const payload = shape === 'rename'
    ? { sessionKey, title: change.kind === 'rename' ? change.title : '' }
    : { sessionKey }
  return {
    type: COMMAND_TYPES[shape],
    commandId: `metadata:${shape}:${sessionKey}:${at}`,
    actor,
    scope: 'system',
    at,
    cwd,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  } as OrchestrationCommand
}

export function recordSessionMetadata(
  sink: EventSink | undefined,
  input: SessionMetadataRef & { change: SessionMetadataChange; actor: string },
  now: number
): SessionMetadataResult {
  if (!sink) return { status: 'unavailable', reason: 'orchestration_unavailable' }
  if (sink.isWriteIndeterminate()) return { status: 'unavailable', reason: 'orchestration_write_indeterminate' }
  const row = findNativeSession(sink, {
    sessionId: input.externalSessionId,
    provider: input.providerId,
    profile: input.agentProfileId ?? null,
    cwd: input.cwd
  })
  if (!row) return { status: 'unavailable', reason: 'session_not_found' }
  if (row.cwd === null) return { status: 'unavailable', reason: 'session_without_cwd' }
  const result = sink.execute(commandFor(row.sessionKey, row.cwd, input.change, input.actor, now))
  if (result.kind === 'rejected') return { status: 'unavailable', reason: result.reason }
  return { status: 'recorded' }
}
