import type { ScExpected, ScOperation, ScRead, ScRef } from './source-control.js'

export interface WorkspaceBranchRef {
  /** Full local or already-fetched remote-tracking ref; never an option or revision expression. */
  name: string
  head: string
  kind: 'local' | 'remote'
}

export interface WorkspaceBranchChoice extends WorkspaceBranchRef {
  worktreeIds: string[]
}

export interface WorkspaceWorktreeChoice {
  id: string
  path: string
  branchRef: string | null
  head: string | null
  current: boolean
  busy: boolean
  bare: boolean
  locked: string | null
  prunable: string | null
}

export type WorkspaceIntent = ScExpected & (
  | { kind: 'current'; branch?: WorkspaceBranchRef }
  | { kind: 'newWorktree'; base: WorkspaceBranchRef; newBranch: string }
  | { kind: 'existingWorktree'; worktreeId: string }
)

export interface WorkspaceChoicesRequest {
  cwd: string
  kind: 'branches' | 'worktrees'
  query?: string
  selectedWorktreeId?: string
  cursor?: { revision: string; offset: number }
}

export interface WorkspaceChoices {
  repositoryId: string
  root: string
  /** Source checkout revision; preparation also revalidates the selected ref's HEAD. */
  revision: string
  branch: string | null
  head: string | null
  dirty: boolean
  writeBlocker: string | null
  commonDirBusy: boolean
  observedAt: number
  /** Preferred new-worktree base when origin/main is already available locally. */
  defaultBase?: WorkspaceBranchRef
  selectedWorktree?: WorkspaceWorktreeChoice
  page:
    | { kind: 'branches'; items: WorkspaceBranchChoice[] }
    | { kind: 'worktrees'; items: WorkspaceWorktreeChoice[] }
  nextCursor: WorkspaceChoicesRequest['cursor'] | null
  /** At most 1,000 matching refs; refine search rather than treating a limit as absence. */
  limited: boolean
}

export interface WorkspaceStartSelection {
  operationId: string
  intent: WorkspaceIntent
}

export interface PreparedWorkspace {
  operationId: string
  repositoryId: string
  cwd: string
  worktreeId: string
  branchRef: string | null
  head: string | null
}

export interface WorkspaceStartStatus {
  operation: ScOperation
  phase: 'planned' | 'git_requested' | 'prepared' | 'start_requested' | 'registered'
  workspace?: PreparedWorkspace
  commandId?: string
  runId?: string
}

/** Desktop-local only. Listing candidates does not grant project authority. */
export interface WorkspaceSelectionApi {
  read: (request: WorkspaceChoicesRequest) => Promise<ScRead<WorkspaceChoices>>
  validateBranch: (request: { repositoryId: string; name: string }) => Promise<ScRead<{ name: string }>>
  inspectStart: (request: ScRef & { operationId: string }) => Promise<ScRead<WorkspaceStartStatus | null>>
}
