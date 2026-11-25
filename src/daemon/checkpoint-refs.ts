/**
 * D5: every finished turn keeps its worktree tree as a git ref, so "roll back to here" is a git
 * operation over content that already exists instead of a copy Scry has to maintain.
 *
 * A ref may point at a tree object directly; that is what makes this cheap. The ref namespace is
 * Scry's own (`refs/scry/checkpoints/`) so a checkpoint never appears as a branch or a tag the user
 * can check out by accident.
 */
export interface CheckpointGit {
  /** Writes the worktree content as a tree, without touching the user's index or HEAD. */
  writeTree(cwd: string): Promise<string>
  updateRef(cwd: string, ref: string, target: string): Promise<void>
  readRef(cwd: string, ref: string): Promise<string | undefined>
  deleteRef(cwd: string, ref: string): Promise<void>
  /** Restores worktree content from a tree. Destructive: callers gate this on a managed worktree. */
  restoreTree(cwd: string, tree: string, before?: string): Promise<void>
}

export type CheckpointCapture =
  | { status: 'captured'; ref: string; tree: string }
  | { status: 'unavailable'; reason: string }

export type CheckpointRollback =
  | { status: 'restored'; ref: string; tree: string }
  | { status: 'unavailable'; reason: string }

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The run id is part of a ref name, so it must not be able to name another ref. */
export function checkpointRef(runId: string): string | undefined {
  return RUN_ID.test(runId) ? `refs/scry/checkpoints/${runId}` : undefined
}

export function checkpointSafetyRef(runId: string): string {
  return `refs/scry/checkpoint-safety/${runId}`
}

export async function captureCheckpoint(
  git: CheckpointGit,
  input: { cwd: string; runId: string; safety?: boolean }
): Promise<CheckpointCapture> {
  const ref = RUN_ID.test(input.runId)
    ? (input.safety ? checkpointSafetyRef(input.runId) : checkpointRef(input.runId))
    : undefined
  if (!ref) return { status: 'unavailable', reason: 'checkpoint_invalid_run_id' }
  let tree: string
  try {
    tree = await git.writeTree(input.cwd)
  } catch {
    return { status: 'unavailable', reason: 'checkpoint_tree_unavailable' }
  }
  if (!tree) return { status: 'unavailable', reason: 'checkpoint_tree_unavailable' }
  try {
    await git.updateRef(input.cwd, ref, tree)
  } catch {
    return { status: 'unavailable', reason: 'checkpoint_ref_unavailable' }
  }
  return { status: 'captured', ref, tree }
}

/**
 * Restores the worktree to a captured tree. It refuses a repository Scry does not manage: the user's
 * own working tree is not ours to rewrite, and a checkpoint is not a substitute for their commits.
 */
export async function rollbackCheckpoint(
  git: CheckpointGit,
  input: { cwd: string; runId: string; managed: boolean; before?: string }
): Promise<CheckpointRollback> {
  if (!input.managed) return { status: 'unavailable', reason: 'checkpoint_unmanaged_worktree' }
  const ref = checkpointRef(input.runId)
  if (!ref) return { status: 'unavailable', reason: 'checkpoint_invalid_run_id' }
  const tree = await git.readRef(input.cwd, ref).catch(() => undefined)
  if (!tree) return { status: 'unavailable', reason: 'checkpoint_missing' }
  try {
    await git.restoreTree(input.cwd, tree, input.before)
  } catch {
    return { status: 'unavailable', reason: 'checkpoint_restore_failed' }
  }
  return { status: 'restored', ref, tree }
}

/** Drops the ref; the tree stays as long as git keeps it reachable from other objects. */
export async function forgetCheckpoint(git: CheckpointGit, input: { cwd: string; runId: string }): Promise<boolean> {
  const ref = checkpointRef(input.runId)
  if (!ref) return false
  await git.deleteRef(input.cwd, ref).catch(() => undefined)
  return true
}
