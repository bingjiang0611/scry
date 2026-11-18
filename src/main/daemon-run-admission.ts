import type { ActiveRun } from '../shared/trace'
import type { RunCursor } from './daemon-run-cursor'
import type { RunWakes } from './daemon-run-wakes'

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
const BIND_WAIT_MS = 250
const TERMINAL = new Set(['settled', 'failed', 'cancelled'])

/** A start the daemon refused before admitting it. The message is the daemon's own. */
export class DaemonRunRefusedError extends Error {}

type LedgerEntry = { runId: string; kind: string; detail?: string }

function isAdmittedMarker(detail: string, ledgerRunId: string): boolean {
  try {
    const marker = JSON.parse(detail) as Record<string, unknown>
    return marker.event === 'admitted' && (marker.ledgerRunId === undefined || marker.ledgerRunId === ledgerRunId)
  } catch { return false }
}

/** Record what one ledger entry says about this run's admission. Other runs' entries are ignored. */
export function noteAdmission(cursor: RunCursor, entry: LedgerEntry): void {
  if (entry.runId !== cursor.runId) return
  if (entry.kind === 'run_failed' || entry.kind === 'run_cancelled') {
    cursor.failure ??= entry.detail && entry.detail.length > 0 ? entry.detail : entry.kind
  } else if (entry.kind === 'run_progress' && entry.detail !== undefined && isAdmittedMarker(entry.detail, cursor.runId)) {
    cursor.admitted = true
  }
}

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
 * Wait for the bind, then for admission. Returns the canonical run id once bound and no
 * longer pending (or when the admission budget ran out: the run is then handed out
 * bound), `undefined` when it never bound. The caller reads the phase afterwards.
 */
export async function awaitAdmission(input: {
  runId: string
  cursor: () => RunCursor | undefined
  step: (waitMs: number) => Promise<unknown>
  wakes: RunWakes
  bindBudgetMs: number
  admitBudgetMs: number
}): Promise<string | undefined> {
  const startedAt = Date.now()
  for (;;) {
    const cursor = input.cursor()
    if (!cursor) return undefined
    const phase = admissionPhase(cursor)
    if (phase === 'refused') return undefined
    if (cursor.scryRunId !== undefined && phase === 'admitted') return cursor.scryRunId
    const deadline = startedAt + (cursor.scryRunId !== undefined ? input.admitBudgetMs : input.bindBudgetMs)
    const terminal = TERMINAL.has(cursor.lifecycle ?? '')
    // Released or disposed: not a run outcome, and nothing more will be read.
    if ((cursor.stopped && !terminal) || Date.now() >= deadline) return cursor.scryRunId
    const position = cursor.watch
    try {
      const wait = Math.min(BIND_WAIT_MS, Math.max(0, deadline - Date.now()))
      const live = input.wakes.live
      if (live) input.wakes.consume(input.runId)
      await input.step(live || terminal ? 0 : wait)
      const after = input.cursor()
      if (live && after && !terminal && admissionPhase(after) === 'pending') await input.wakes.wait(input.runId, wait)
      // Ended and every entry read without admission evidence: a terminal failure before
      // registration, even if its own entry carried no reason.
      if (after && terminal && after.watch === position && admissionPhase(after) === 'pending') {
        after.failure ??= after.lifecycle === 'cancelled' ? 'run_cancelled' : 'run_failed'
      }
    } catch {
      // The intent is already recorded. A denied or broken read must not turn a
      // recorded submit into a failed start; the pump reports the reason.
      return input.cursor()?.scryRunId
    }
  }
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
