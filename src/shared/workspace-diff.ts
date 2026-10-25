import type { TurnDiffSnapshot, WorkspaceDiffResult } from './trace.js'

export type GitDiffScope = 'workspace' | 'branch'
export interface BranchDiffComparison {
  baseRef: string | null
  baseCommit: string
  headRef: string | null
}

/** Both totals and patch bodies are projected from these same immutable Git trees. */
export type WorkspaceDiffSnapshotResult =
  | {
      status: 'captured'
      head: string
      revision: string
      collectedAt: string
      snapshot: TurnDiffSnapshot
      comparison?: BranchDiffComparison
    }
  | Exclude<WorkspaceDiffResult, { status: 'captured' }>
