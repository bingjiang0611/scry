import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { gitCommand } from '../core/turn-recorder/git-command'
import { createCheckpointGit } from './checkpoint-git'
import { isManagedWorktreePath } from '../main/app-store'
import { applyRunRollback, recordRunCheckpoint, type CheckpointRecordResult, type CheckpointRestoreResult } from './checkpoint-recorder'
import { checkpointSafetyRef, type CheckpointGit } from './checkpoint-refs'

/**
 * R9: how many refs one worktree keeps. A checkpoint is a convenience, not a backup service, and an
 * unbounded namespace both grows without limit and hides which state the user can still return to.
 */
const MAX_CHECKPOINTS_PER_WORKTREE = 20

export interface CheckpointService {
  /** D5: capture the finished run's worktree. Never throws: a settlement must not fail on git. */
  capture(input: { runId: string; cwd: string }): Promise<CheckpointRecordResult | undefined>
  /**
   * D5: restore a captured tree. The run's cwd comes from the projection, and Scry only rewrites a
   * worktree it manages — the user's own checkout is not ours to reset.
   */
  rollback(input: { runId: string; reason?: string }): Promise<CheckpointRestoreResult>
}

/**
 * D5 lives behind one seam because capture happens on every settled run and rollback happens once
 * on demand: both need the same sink and the same git adapter, and neither may take the host down.
 */
export function createCheckpointService(deps: {
  sink: () => EventSink | undefined
  git: CheckpointGit
  isManagedWorktree: (cwd: string) => boolean
  now?: () => number
  warn?: (message: string, error: unknown) => void
  maxCheckpoints?: number
}): CheckpointService {
  const now = deps.now ?? Date.now
  const maxCheckpoints = deps.maxCheckpoints ?? MAX_CHECKPOINTS_PER_WORKTREE
  /** Drops the refs of runs this worktree no longer keeps, and forgets them in the projection too. */
  const prune = async (sink: EventSink | undefined, cwd: string): Promise<void> => {
    if (!sink) return
    const rows = sink.handle.db
      .prepare(
        `SELECT run_id AS runId, checkpoint_ref AS ref FROM orch_p_run
         WHERE cwd = ? AND checkpoint_ref IS NOT NULL
         ORDER BY COALESCE(settled_at, 0) DESC, rev_seq DESC`
      )
      .all(cwd) as Array<{ runId: string; ref: string }>
    // Linked worktrees share their repository's ref namespace. Only prune refs owned by these rows.
    for (const { runId, ref } of rows.slice(maxCheckpoints)) {
      try {
        await deps.git.deleteRef(cwd, ref)
        await deps.git.deleteRef(cwd, checkpointSafetyRef(runId))
        const payload = { runId, ref }
        sink.execute({
          type: 'run.checkpoint_forgotten',
          commandId: `checkpoint-forgotten:${runId}`,
          actor: 'system',
          scope: 'system',
          at: now(),
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        })
      } catch (error) {
        deps.warn?.('checkpoint pruning failed', error)
      }
    }
  }
  return {
    async capture(input) {
      // R9: the user's own checkout is not ours to write trees into on every settled run.
      if (!deps.isManagedWorktree(input.cwd)) {
        return { status: 'unavailable', reason: 'checkpoint_unmanaged_worktree' }
      }
      try {
        const captured = await recordRunCheckpoint(deps.sink(), deps.git, input, now())
        if (captured.status === 'captured') await prune(deps.sink(), input.cwd)
        return captured
      } catch (error) {
        deps.warn?.('checkpoint capture failed', error)
        return undefined
      }
    },
    async rollback(input) {
      const sink = deps.sink()
      if (!sink) return { status: 'unavailable', reason: 'orchestration_unavailable' }
      const run = sink.getRun(input.runId)
      if (!run?.cwd) return { status: 'unavailable', reason: 'checkpoint_run_cwd_unknown' }
      return applyRunRollback(deps.sink(), deps.git, {
        runId: input.runId,
        cwd: run.cwd,
        managed: deps.isManagedWorktree(run.cwd),
        ...(input.reason ? { reason: input.reason } : {})
      }, now())
    }
  }
}

/**
 * The host's checkpoint service: the git adapter it uses writes trees through a private index, and
 * a git failure is logged rather than thrown out of a run's settlement.
 */
export function createHostCheckpointService(deps: {
  sink: () => EventSink | undefined
  userDataDir: string
  log: (line: string) => void
}): CheckpointService {
  return createCheckpointService({
    sink: deps.sink,
    isManagedWorktree: (cwd) => isManagedWorktreePath(deps.userDataDir, cwd),
    git: createCheckpointGit({
      git: (args, options) =>
        gitCommand(args, { cwd: options.cwd, ...(options.env ? { env: options.env } : {}), deadline: Date.now() + 20_000 })
    }),
    warn: (message, error) => deps.log(`${message}: ${String(error)}`)
  })
}
