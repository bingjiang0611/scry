import type { OrchestrationCommand } from './orchestrator-commands'
import { acceptDecision, makeEvent, stickyReject, type DecisionResult, type OrchestratorReadView } from './orchestrator-handlers'
import { canTransitionRun } from './run-transitions'

type CheckpointCommand = Extract<OrchestrationCommand, { type: 'run.checkpoint' }>
type RollbackCommand = Extract<OrchestrationCommand, { type: 'run.rollback' }>
type ForgottenCommand = Extract<OrchestrationCommand, { type: 'run.checkpoint_forgotten' }>

/**
 * D5: the checkpoint row is recorded from evidence the host already produced — a git ref and the
 * tree it points at. The decision never invents a tree, and it never moves the run's lifecycle.
 */
export function decideRunCheckpoint(cmd: CheckpointCommand, view: OrchestratorReadView): DecisionResult {
  const p = cmd.payload
  const run = view.getRun(p.runId)
  if (!run) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  if (!p.ref || !p.tree) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  const event = makeEvent(cmd, 0, {
    type: 'checkpoint.captured',
    stream: `run:${run.runId}`,
    sessionKey: run.sessionKey,
    runId: run.runId,
    cwd: p.cwd ?? run.cwd,
    payload: { runId: run.runId, ref: p.ref, tree: p.tree }
  })
  return acceptDecision(cmd, [event], [], { runId: run.runId })
}

/**
 * R9: retention deleted a ref, and a run that still reports `hasCheckpoint` would offer the App a rollback
 * that cannot work. Forgetting it is its own recorded decision, not a silent column reset.
 */
export function decideRunCheckpointForgotten(cmd: ForgottenCommand, view: OrchestratorReadView): DecisionResult {
  const p = cmd.payload
  const run = view.getRun(p.runId)
  if (!run) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  if (!run.checkpointRef || run.checkpointRef !== p.ref) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  return acceptDecision(cmd, [makeEvent(cmd, 0, {
    type: 'checkpoint.forgotten',
    stream: `run:${run.runId}`,
    sessionKey: run.sessionKey,
    runId: run.runId,
    cwd: run.cwd,
    payload: { runId: run.runId, ref: p.ref }
  })], [], { runId: run.runId })
}

/**
 * D5: rollback restores a worktree, so it is only allowed for a finished run whose recorded ref is
 * the one being restored. A live run must be stopped first; otherwise the restore would race the
 * Provider still writing into the same files.
 */
export function decideRunRollback(cmd: RollbackCommand, view: OrchestratorReadView): DecisionResult {
  const p = cmd.payload
  const run = view.getRun(p.runId)
  if (!run) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  if (!run.checkpointRef || run.checkpointRef !== p.ref) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  if (!canTransitionRun(run.lifecycle, 'rolled_back')) return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
  const fields = { stream: `run:${run.runId}`, sessionKey: run.sessionKey, runId: run.runId, cwd: run.cwd }
  return acceptDecision(cmd, [
    makeEvent(cmd, 0, {
      type: 'checkpoint.rollback_requested',
      ...fields,
      payload: { runId: run.runId, ref: p.ref, ...(p.reason ? { reason: p.reason } : {}) }
    }),
    makeEvent(cmd, 1, {
      type: 'run.rolled_back',
      ...fields,
      payload: { runId: run.runId, ref: p.ref, rolledBackAt: cmd.at }
    })
  ], [], { runId: run.runId, lifecycle: 'rolled_back' })
}
