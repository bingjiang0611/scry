// Public recorder Git API; snapshot storage and evidence collection remain shared.
export {
  type GitTurnDiffCapture,
  type GitTurnDiffFinishOptions,
  type GitTurnDiffBaseline,
  cloneGitTurnDiffCapture,
  beginGitTurnDiff
} from './git-capture.js'
export {
  type NewWorktreeBaselineOptions,
  type NewWorktreeBaselinePlan,
  type NewTurnWorktreeQuery,
  MAX_NEW_WORKTREE_BASELINES,
  findNewTurnWorktrees,
  finishNewWorktreeBaseline
} from './git-worktree-baseline.js'
export {
  parsePorcelainPaths
} from './git-compute.js'
export {
  limitTurnDiffPatchBytes,
  parseNameStatus,
  parseNumstat
} from './git-patches.js'
export {
  finishGitTurnDiff,
  finishGitTurnAndSessionDiff,
  snapshotSessionNetDiff,
  previewGitTurnDiff,
  cancelGitTurnDiff
} from './git-lifecycle.js'
export {
  type WorkspaceGitDiff,
  readWorkspaceGitDiff,
  readWorkspaceNumstat,
  gitNumstat
} from './git-workspace.js'
