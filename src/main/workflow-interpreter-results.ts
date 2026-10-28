import type { WorkflowAttemptOutcome, WorkflowControlFrame, WorkflowEvaluation, WorkflowProgress } from '../shared/workflow'
import { workflowFrameCopy } from '../shared/constants/copy'

export const retainPhase = (previous: WorkflowControlFrame['phase'], next: WorkflowControlFrame['phase']): WorkflowControlFrame['phase'] =>
  (['unknown', 'stopped', 'failed', 'blocked', 'completed'] as const).find(phase => phase === previous || phase === next) ?? 'unknown'
export const unavailable = (reason = workflowFrameCopy.failedValue): WorkflowEvaluation => ({ state: 'unknown', reason, derivedFrom: [] })
/** A missing control checkpoint stays unknown even when collected effects have known failures. */
export function workflowCompletionPhase(base: WorkflowControlFrame['phase'], terminal: WorkflowControlFrame['phase'] = 'completed'): WorkflowControlFrame['phase'] {
  return terminal === 'unknown' || base === 'completed' ? terminal : base
}
/** Root-state precedence is distinct from a child's control-flow phase. */
export function workflowRootState(phase: WorkflowControlFrame['phase'], outcomes: WorkflowAttemptOutcome[], stopped: boolean, blockedReason?: string): WorkflowProgress['state'] {
  if (phase === 'unknown' || outcomes.some(outcome => outcome.state === 'unknown' || !outcome.settled)) return 'unknown'
  if (phase === 'blocked' || blockedReason || outcomes.some(outcome => outcome.state === 'blocked')) return 'blocked'
  if (stopped || phase === 'stopped') return 'stopped'
  if (phase === 'failed' || outcomes.some(outcome => outcome.state === 'failed')) return 'failed'
  return 'completed'
}

export function workflowExecutionPhase(outcomes: WorkflowAttemptOutcome[], stopped: boolean, blockedReason?: string): WorkflowControlFrame['phase'] {
  return outcomes.some(outcome => !outcome.settled || outcome.state === 'unknown') ? 'unknown'
    : stopped ? 'stopped'
      : blockedReason || outcomes.some(outcome => outcome.state === 'blocked') ? 'blocked'
        : outcomes.some(outcome => outcome.state !== 'completed') ? 'failed' : 'completed'
}
