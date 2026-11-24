import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { canTransitionRun } from '../host-runtime/orchestration/run-transitions'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { OrchestrationCommand } from '../host-runtime/orchestration/orchestrator-commands'
import { captureCheckpoint, rollbackCheckpoint, type CheckpointGit } from './checkpoint-refs'

export type CheckpointRecordResult =
  | { status: 'captured'; ref: string; tree: string }
  | { status: 'unavailable'; reason: string }

export type CheckpointRestoreResult =
  | { status: 'restored'; ref: string; tree: string }
  | { status: 'unavailable'; reason: string }

function submit(sink: EventSink, command: Omit<OrchestrationCommand, 'payloadSha256' | 'actor' | 'scope'> & Record<string, unknown>): { ok: boolean; reason?: string } {
  const payload = (command as { payload: Record<string, unknown> }).payload
  const result = sink.execute({
    ...(command as object),
    actor: 'system',
    scope: 'system',
    payloadSha256: sha256Hex(canonicalJson(payload))
  } as OrchestrationCommand)
  return result.kind === 'rejected' ? { ok: false, reason: result.reason } : { ok: true }
}

/**
 * D5: capture the finished run's worktree and record the ref. Nothing is recorded when git cannot
 * produce a tree: a checkpoint that does not exist must not appear in the event log.
 */
export async function recordRunCheckpoint(
  sink: EventSink | undefined,
  git: CheckpointGit,
  input: { runId: string; cwd: string; sessionKey?: string | null },
  now: number
): Promise<CheckpointRecordResult> {
  if (!sink) return { status: 'unavailable', reason: 'orchestration_unavailable' }
  if (sink.isWriteIndeterminate()) return { status: 'unavailable', reason: 'orchestration_write_indeterminate' }
  const captured = await captureCheckpoint(git, { cwd: input.cwd, runId: input.runId })
  if (captured.status !== 'captured') return captured
  const result = submit(sink, {
    type: 'run.checkpoint',
    commandId: `checkpoint:${input.runId}`,
    at: now,
    payload: { runId: input.runId, ref: captured.ref, tree: captured.tree, cwd: input.cwd }
  })
  if (!result.ok) return { status: 'unavailable', reason: result.reason ?? 'checkpoint_record_rejected' }
  return captured
}

/**
 * D5: the rewrite is destructive, so every reason to refuse is checked before it runs. Only then is
 * the worktree restored and the rollback recorded; a failed restore leaves the run's lifecycle alone,
 * so the row never claims an undone state.
 */
export async function applyRunRollback(
  sink: EventSink | undefined,
  git: CheckpointGit,
  input: { runId: string; cwd: string; managed: boolean; reason?: string },
  now: number
): Promise<CheckpointRestoreResult> {
  if (!sink) return { status: 'unavailable', reason: 'orchestration_unavailable' }
  if (sink.isWriteIndeterminate()) return { status: 'unavailable', reason: 'orchestration_write_indeterminate' }
  const run = sink.getRun(input.runId)
  if (!run?.checkpointRef) return { status: 'unavailable', reason: 'checkpoint_missing' }
  // The authority only accepts a rollback from a settled run. Checking it here keeps the refusal from
  // arriving after the files were already rewritten — "拒绝" must mean nothing changed.
  if (!canTransitionRun(run.lifecycle, 'rolled_back')) return { status: 'unavailable', reason: 'illegal_transition' }
  const restored = await rollbackCheckpoint(git, { cwd: input.cwd, runId: input.runId, managed: input.managed })
  if (restored.status !== 'restored') return restored
  const result = submit(sink, {
    type: 'run.rollback',
    commandId: `rollback:${input.runId}:${now}`,
    at: now,
    payload: { runId: input.runId, ref: restored.ref, ...(input.reason ? { reason: input.reason } : {}) }
  })
  if (!result.ok) return { status: 'unavailable', reason: result.reason ?? 'rollback_record_rejected' }
  return restored
}
