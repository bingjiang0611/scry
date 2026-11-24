import type { Evidence } from '../shared/turn-record-contracts'
import type { RecorderTerminalEvidence } from '../host-runtime/orchestration/recovery'

export interface TerminalSettlementWrites {
  /** `run.provider_settled`: the Provider process ended; recorder evidence may not exist yet. */
  providerSettled: () => void
  /** `run.finalized`: the trace archive is durable; carries the recorder-derived evidence. */
  finalized: (evidence: RecorderTerminalEvidence) => void
  /** The terminal lifecycle event, written immediately from the Provider exit. */
  terminal: () => void
}

export interface TerminalSettlementOptions {
  writes: TerminalSettlementWrites
  /** Recorder evidence lookup; returns undefined until the archive or span is committed. */
  findEvidence: () => RecorderTerminalEvidence | undefined
  /** Bounded wait for the archive; the terminal event is written even when it never appears. */
  deadlineMs: number
  intervalMs: number
  schedule: (fn: () => void, ms: number) => void
}

/** Production wait budget: the App commits the trace archive right after the Provider exits. */
export const TERMINAL_EVIDENCE_DEADLINE_MS = 1_500
export const TERMINAL_EVIDENCE_INTERVAL_MS = 150

/**
 * A3: live runs used to record only a terminal event sourced from `provider`, which left
 * `last_run_outcome` without recorder evidence. The sequence is now
 * `provider_settled` -> terminal (inferred from the Provider exit) -> `finalized` (recorder
 * evidence), so the session outcome is upgraded to `exact` once the archive is durable.
 *
 * Settlement stays synchronous: the terminal event is never delayed waiting for the App's
 * archive. `finalized` is written once, at most, when recorder evidence becomes available.
 */
export function settleRunTerminal(options: TerminalSettlementOptions): void {
  const { writes } = options
  writes.providerSettled()
  writes.terminal()
  const deadlineAt = Date.now() + options.deadlineMs
  const attempt = (): void => {
    const evidence = options.findEvidence()
    if (evidence) {
      writes.finalized(evidence)
      return
    }
    if (Date.now() >= deadlineAt) return
    options.schedule(attempt, options.intervalMs)
  }
  const found = options.findEvidence()
  if (found) {
    writes.finalized(found)
    return
  }
  options.schedule(attempt, options.intervalMs)
}

type TerminalStep = 'settled' | 'failed' | 'cancelled'

export interface ProgressWrite {
  runId: string
  step: 'provider_settled' | 'finalized'
  commandSuffix: string
  reason?: string
  isError?: boolean
  outputSeq?: number
  contentRef?: string
  evidence?: string[]
}

export interface TerminalWrite {
  runId: string
  appRunId?: string
  step: TerminalStep
  reason?: string
  evidence?: string[]
  outcome?: Evidence<string>
}

export interface AuthorityTerminalHandlerDeps {
  engine: {
    recordProgress(input: ProgressWrite): void
    recordTerminal(input: TerminalWrite): void
  }
  liveRunMeta(runId: string): { admitted?: boolean; scryRunId?: string } | undefined
  resolveCanonical(runId: string): string
  findRecorderEvidence?: (runId: string) => RecorderTerminalEvidence | undefined
  schedule: (fn: () => void, ms: number) => void
  evidenceFor: (step: TerminalStep) => string[]
  releaseRun: (canonicalRunId: string, dispatchRunId: string) => void
  /**
   * C4: a failed run may have failed on a Provider quota. The handler reports the failure text and
   * lets the caller decide what it means; it never interprets Provider wording itself.
   */
  onProviderFailure?: (input: { runId: string; detail: string | undefined }) => void
}

/** Wires the live-run terminal sequence for the daemon authority hooks. */
export function createAuthorityRunTerminalHandler(
  deps: AuthorityTerminalHandlerDeps
): (runId: string, step: TerminalStep, detail?: string) => void {
  return (dispatchRunId, step, detail) => {
    const runId = deps.resolveCanonical(dispatchRunId)
    const binding = deps.liveRunMeta(runId)
    const appRunId = binding?.admitted && binding.scryRunId ? binding.scryRunId : undefined
    const baseEvidence = deps.evidenceFor(step)
    // Before release: the caller resolves the session from what the run left in the projection.
    if (step === 'failed') deps.onProviderFailure?.({ runId, detail })
    deps.releaseRun(runId, dispatchRunId)
    settleRunTerminal({
      findEvidence: () => deps.findRecorderEvidence?.(runId),
      deadlineMs: TERMINAL_EVIDENCE_DEADLINE_MS,
      intervalMs: TERMINAL_EVIDENCE_INTERVAL_MS,
      schedule: deps.schedule,
      writes: {
        providerSettled: () =>
          deps.engine.recordProgress({
            runId,
            step: 'provider_settled',
            commandSuffix: 'live',
            isError: step === 'failed',
            ...(detail ? { reason: detail } : {}),
            evidence: baseEvidence
          }),
        finalized: (evidence) =>
          deps.engine.recordProgress({
            runId,
            step: 'finalized',
            commandSuffix: 'live',
            ...(evidence.contentRef ? { contentRef: evidence.contentRef } : {}),
            ...(evidence.outputSeq !== undefined ? { outputSeq: evidence.outputSeq } : {}),
            evidence: evidence.evidence
          }),
        terminal: () =>
          deps.engine.recordTerminal({
            runId,
            step,
            ...(appRunId ? { appRunId } : {}),
            ...(detail ? { reason: detail } : {}),
            evidence: baseEvidence
          })
      }
    })
  }
}
