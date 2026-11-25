import type { DaemonLocalOpGroup } from './deps'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * D5: rolling a run back rewrites its worktree, so the op refuses anything that is not a plain run
 * id and leaves the decision about which worktrees may be reset to the checkpoint service.
 */
export const checkpointLocalOps: DaemonLocalOpGroup = (deps) => ({
  'agent:rollbackRun': async (input: unknown) => {
    const value = (input ?? {}) as { runId?: unknown; reason?: unknown }
    if (typeof value.runId !== 'string' || !RUN_ID.test(value.runId)) throw new Error('invalid_run_id')
    const checkpoints = deps.checkpoints
    if (!checkpoints) throw new Error('checkpoint_unavailable')
    return checkpoints.rollback({
      runId: value.runId,
      ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {})
    })
  }
})
