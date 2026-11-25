import type { ProviderRunRequest } from './types'
import type { QoderSessionTurnSlot } from './qoder-session-pool'

/**
 * R3: what the session's SDK closures need from the turn that is running now. Written into the
 * session's slot before each turn, so a permission question, a pid report or an exit lands on the
 * turn that owns them instead of the turn that happened to open the process.
 */
export interface QoderTurnBindings {
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    permission: never
  ) => Promise<unknown>
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

/**
 * R3: the identity part of the key names *this conversation*, never the workspace. `continuationKey`
 * is Provider-level, so keying on it made two new conversations in one directory share the same
 * `fresh` session — B's prompt landed in A's context. A fresh turn therefore carries its own run id,
 * and a continued turn is keyed by the native session it resumes (the pool keeps the alias from the
 * native id to the process that reported it).
 */
function qoderSessionIdentity(request: ProviderRunRequest): string {
  return request.resume ? `native:${request.resume}` : `fresh:${request.runId}`
}

/**
 * Reuse is safe only when the next turn asks for exactly what the session was opened with, so the
 * rest of the key is every turn option the SDK fixes at open time.
 */
export function qoderSessionKey(request: ProviderRunRequest): string {
  return [
    qoderSessionIdentity(request),
    JSON.stringify([request.cwd, request.agentProfileId, request.managedRecorder === true, request.managedRecorderIdentity ? request.runId : null]),
    request.permissionMode ?? 'default',
    request.requestUserInput ? 'ask' : 'no_ask',
    request.model?.id ?? 'default',
    request.effort ?? 'default',
    JSON.stringify(request.mcpExecution ?? null)
  ].join('|')
}

/**
 * The single indirection the SDK's retained callbacks go through. `slot.current` is whichever turn
 * is live; `slot.transport` outlives one turn because it belongs to the session.
 */
export function createQoderTurnSlot(initial: QoderTurnBindings): QoderSessionTurnSlot {
  return { current: initial }
}
