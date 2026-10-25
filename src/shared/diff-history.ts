import type { WorkspaceDiffSnapshotResult } from './workspace-diff.js'

export interface DiffCommit {
  hash: string
  parents: string[]
  subject: string
  author: string
  committedAt: string
}
export interface DiffRangeRequest {
  cwd: string
  baseCommit: string
  head: string
}
export interface DiffCommitPageRequest extends DiffRangeRequest { offset: number }
export interface DiffCommitSnapshotRequest extends DiffRangeRequest { commit: string }
export type DiffCommitPage =
  | { status: 'available'; commits: DiffCommit[]; nextOffset: number | null; truncated: boolean }
  | { status: 'failed' | 'unavailable'; reason: 'git_error' | 'deadline' | 'workspace_limit' | 'invalid_range' }
export type DiffCommitSnapshot =
  | (Extract<WorkspaceDiffSnapshotResult, { status: 'captured' }> & { commit: DiffCommit })
  | Exclude<WorkspaceDiffSnapshotResult, { status: 'captured' }>

export const DIFF_COMMIT_PAGE_SIZE = 50
export const DIFF_COMMIT_LIMIT = 1_000
