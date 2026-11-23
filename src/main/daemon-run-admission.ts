import type { ActiveRun } from '../shared/trace'
import type { RunCursor } from './daemon-run-cursor'

// Whether the daemon admitted a run the App submitted (B4-V trust-gate). In process,
// `agent:start` answers only after admission - workspace, session conflicts, Codex
// Hook / OpenCode plugin / repository MCP trust re-verification - so a refused start
// rejects with the pipeline's own message and no run ever exists. The daemon runs the
// same admission, but after it bound a run id (the ledger's first progress marker).
// Answering at that bind handed the window a run that the trust gate then refused
// before registration: nothing on the trace, no `done`, a run that never settled.
//
// The daemon's ledger says which it was: `admitted` once the run is registered (the
// same moment the in-process start returns), or `run_failed` / `run_cancelled` with the
// refusal before it. The App waits for one of them, as the in-process start does, and
// a refusal rejects the start with the daemon's own message.

// Longer than the pipeline's own wait for a previous turn of the same session
// (ADMISSION_DEADLINE_MS, 20 s): a start that waits behind one is still admitted or
// refused within it. Past it the run is handed out bound, and a later refusal still
// ends it (refusedView, lateRefusalNotice) instead of leaving it open.
export const DEFAULT_ADMIT_BUDGET_MS = 30_000

/** A start the daemon refused before admitting it. The message is the daemon's own. */
export class DaemonRunRefusedError extends Error {}

/**
 * `admitted`: the daemon registered the run (its marker, a trace of it, its output, or a
 * settled end). `refused`: its terminal failure was read with none of that before it,
 * in ledger order. Anything else is still `pending`.
 */
export function admissionPhase(cursor: RunCursor): 'pending' | 'admitted' | 'refused' {
  if (cursor.admitted || cursor.latest !== undefined || cursor.output > 0 || cursor.lifecycle === 'settled') return 'admitted'
  return cursor.failure !== undefined ? 'refused' : 'pending'
}

/**
 * The window's view of a run refused after it was handed out: the ledger's terminal
 * failure, with no trace items because the daemon never registered one. `null` while the
 * run is not known to be refused.
 */
export function refusedView(cursor: RunCursor): ActiveRun | null {
  if (cursor.scryRunId === undefined || admissionPhase(cursor) !== 'refused') return null
  const context = cursor.context
  return {
    runId: cursor.scryRunId,
    ...(context ? { providerId: context.providerId as ActiveRun['providerId'], cwd: context.cwd } : {}),
    ...(context?.agentProfileId ? { agentProfileId: context.agentProfileId } : {}),
    userText: cursor.userText ?? '',
    items: [],
    done: true,
    error: cursor.failure
  }
}

/** The in-process failure notice, for a run this window was handed and the daemon then refused. */
export function lateRefusalNotice(cursor: RunCursor): { runId: string; message: string } | undefined {
  if (!cursor.handedOut || cursor.scryRunId === undefined || admissionPhase(cursor) !== 'refused') return undefined
  return { runId: cursor.scryRunId, message: cursor.failure ?? 'run_failed' }
}
