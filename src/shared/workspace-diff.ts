import type { TurnDiffSnapshot, WorkspaceDiffResult } from './trace.js'

export type GitDiffScope = 'workspace' | 'branch'
export interface BranchDiffComparison {
  baseRef: string | null
  baseCommit: string
  headRef: string | null
}

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
