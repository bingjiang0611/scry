import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { gitCommand } from '../core/turn-recorder/git-command'
import { createCheckpointGit } from './checkpoint-git'
import { applyRunRollback, recordRunCheckpoint, type CheckpointRecordResult, type CheckpointRestoreResult } from './checkpoint-recorder'
import type { CheckpointGit } from './checkpoint-refs'

export interface CheckpointService {
  /** D5: capture the finished run's worktree. Never throws: a settlement must not fail on git. */
  capture(input: { runId: string; cwd: string }): Promise<CheckpointRecordResult | undefined>
  /** D5: restore a captured tree. `managed` decides whether Scry may rewrite this worktree. */
  rollback(input: { runId: string; cwd: string; managed: boolean; reason?: string }): Promise<CheckpointRestoreResult>
}

/**
 * D5 lives behind one seam because capture happens on every settled run and rollback happens once
 * on demand: both need the same sink and the same git adapter, and neither may take the host down.
 */
export function createCheckpointService(deps: {
  sink: () => EventSink | undefined
  git: CheckpointGit
  now?: () => number
  warn?: (message: string, error: unknown) => void
}): CheckpointService {
  const now = deps.now ?? Date.now
  return {
    async capture(input) {
      try {
        return await recordRunCheckpoint(deps.sink(), deps.git, input, now())
      } catch (error) {
        deps.warn?.('checkpoint capture failed', error)
        return undefined
      }
    },
    async rollback(input) {
      return applyRunRollback(deps.sink(), deps.git, input, now())
    }
  }
}

/**
 * The host's checkpoint service: the git adapter it uses writes trees through a private index, and
 * a git failure is logged rather than thrown out of a run's settlement.
 */
export function createHostCheckpointService(deps: {
  sink: () => EventSink | undefined
  log: (line: string) => void
}): CheckpointService {
  return createCheckpointService({
    sink: deps.sink,
    git: createCheckpointGit({
      git: (args, options) =>
        gitCommand(args, { cwd: options.cwd, ...(options.env ? { env: options.env } : {}), deadline: Date.now() + 20_000 })
    }),
    warn: (message, error) => deps.log(`${message}: ${String(error)}`)
  })
}
