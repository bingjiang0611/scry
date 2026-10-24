import type { WorkflowAttemptOutcome, WorkflowControlFrame, WorkflowEvaluation } from '../shared/workflow'
import { workflowFrameCopy } from '../shared/constants/copy'

export const retainPhase = (previous: WorkflowControlFrame['phase'], next: WorkflowControlFrame['phase']): WorkflowControlFrame['phase'] =>
  (['unknown', 'stopped', 'failed', 'blocked', 'completed'] as const).find(phase => phase === previous || phase === next) ?? 'unknown'
export const unavailable = (reason = workflowFrameCopy.failedValue): WorkflowEvaluation => ({ state: 'unknown', reason, derivedFrom: [] })
export function workflowExecutionPhase(outcomes: WorkflowAttemptOutcome[], stopped: boolean, blockedReason?: string): WorkflowControlFrame['phase'] {
  return outcomes.some(outcome => !outcome.settled || outcome.state === 'unknown') ? 'unknown'
    : stopped ? 'stopped'
      : blockedReason || outcomes.some(outcome => outcome.state === 'blocked') ? 'blocked'
        : outcomes.some(outcome => outcome.state !== 'completed') ? 'failed' : 'completed'
}
