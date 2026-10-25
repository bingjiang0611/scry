export interface ScFile {
  path: string
  previousPath?: string
  index: string
  worktree: string
  untracked: boolean
  conflict: boolean
}

export interface ScRemote {
  name: string
  /** Effective, credential-free push destination. Multiple destinations are not writable. */
  pushUrls: string[]
  fetchUrls: string[]
}

export type ScGitAction = 'stage' | 'unstage' | 'commit' | 'fetch' | 'push' | 'prepareWorkspace'

export interface ScRepository {
  id: string
  root: string
  branch: string | null
  head: string | null
  revision: string
  observedAt: number
  upstream: string | null
  ahead: number | null
  behind: number | null
  files: ScFile[]
  remotes: ScRemote[]
  /** Repository-wide blockers (conflict, unfinished operation, active Agent, unknown result). */
  writeBlocker: string | null
  actionBlockers: Partial<Record<ScGitAction, string>>
}

export type ScRead<T> =
  | { status: 'available'; data: T }
  | { status: 'unavailable' | 'failed'; reason: string }

export interface ScDiff {
  patch: string
  truncated: boolean
  binary: boolean
}

export interface ScRef {
  repositoryId: string
}
export interface ScExpected extends ScRef {
  expectedRevision: string
}
export interface ScPrRef extends ScRef {
  /** GitHub identity, not a Git transport credential. */
  repository: string
  number: number
}
export interface ScPrExpected extends ScPrRef {
  account: string
  head: string
  base: string
}

export interface ScInlineComment {
  path: string
  side: 'LEFT' | 'RIGHT'
  line: number
  body: string
}
export interface ScCommitDraft extends ScRef {
  head: string | null
  message: string
}

export interface ScReviewDraft extends ScPrExpected {
  body: string
  verdict: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
  comments: ScInlineComment[]
}

export type ScMutation =
  | (ScExpected & { action: 'stage'; paths: string[]; allowStagedOverwrite?: boolean })
  | (ScExpected & { action: 'unstage'; paths: string[] })
  | (ScExpected & { action: 'commit'; message: string; paths?: string[] })
  | (ScExpected & { action: 'fetch'; remote: string })
  | (ScExpected & { action: 'push'; remote: string })
  | (ScExpected & {
      action: 'createPr'
      repository: string
      account: string
      headRepository: string
      headBranch: string
      baseBranch: string
      title: string
      body: string
      draft: boolean
    })
  | (ScPrExpected & {
      action: 'review'
      body: string
      verdict: ScReviewDraft['verdict']
      comments: ScInlineComment[]
    })
  | (ScPrExpected & { action: 'merge'; method: 'merge' | 'squash' | 'rebase' })

export interface ScOperation {
  id: string
  repositoryId: string
  action: ScMutation['action'] | 'prepareWorkspace'
  status: 'running' | 'succeeded' | 'failed' | 'unknown'
  startedAt: number
  acknowledged?: boolean
  message: string
  /** Only authoritative evidence, never an inferred success from dispatch. */
  evidence?: { sha?: string; url?: string; number?: number; reviewId?: number }
}

export interface ScCheck {
  name: string
  state: 'passed' | 'pending' | 'failed' | 'neutral' | 'skipped' | 'unknown'
}
export interface ScPrFile extends ScDiff {
  path: string
  previousPath?: string
  status: string
  additions: number
  deletions: number
}
export interface ScPr {
  repository: string
  number: number
  title: string
  body: string
  url: string
  author: string
  account: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  head: string
  base: string
  headBranch: string
  baseBranch: string
  mergeState: string
  mergeable: boolean | null
  canWrite: boolean
  methods: Array<'merge' | 'squash' | 'rebase'>
  checks: ScCheck[]
  checksComplete: boolean
  files: ScPrFile[]
  filesComplete: boolean
  comments: Array<{
    id: number
    author: string
    body: string
    url: string
    path?: string
    line?: number | null
    head?: string
  }>
  reviews: Array<{ id: number; author: string; body: string; state: string; head: string }>
  activityComplete: boolean
  observedAt: number
}

export interface ScPrList {
  account: string
  repository: string
  defaultBranch: string
  items: Array<{
    number: number
    title: string
    headBranch: string
    headRepository: string | null
    baseBranch: string
    url: string
  }>
  complete: boolean
}

export interface SourceControlApi {
  read: (cwd: string) => Promise<ScRead<ScRepository>>
  diff: (request: ScExpected & { path: string; staged: boolean }) => Promise<ScRead<ScDiff>>
  mutate: (request: ScMutation & { operationId: string }) => Promise<ScOperation>
  operations: (request: ScRef) => Promise<ScOperation[]>
  reconcile: (request: ScRef & { operationId: string }) => Promise<ScOperation>
  acknowledge: (request: ScRef & { operationId: string }) => Promise<ScOperation>
  pullRequests: (request: ScRef & { repository: string }) => Promise<ScRead<ScPrList>>
  pullRequest: (request: ScPrRef) => Promise<ScRead<ScPr>>
  saveCommitDraft: (draft: ScCommitDraft) => Promise<void>
  loadCommitDraft: (request: ScRef) => Promise<ScCommitDraft | null>
  saveDraft: (draft: ScReviewDraft) => Promise<void>
  loadDraft: (request: ScPrRef) => Promise<ScReviewDraft | null>
}

export function scCanMerge(pr: ScPr): boolean {
  // GitHub is still authoritative at dispatch. Empty or partial checks are not a green light.
  return (
    pr.state === 'open' &&
    !pr.draft &&
    pr.canWrite &&
    pr.mergeable === true &&
    pr.mergeState === 'clean' &&
    pr.checksComplete &&
    pr.methods.length > 0 &&
    pr.checks.every((check) => ['passed', 'neutral', 'skipped'].includes(check.state))
  )
}

export function githubRepositoryFromUrl(value: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@(?:github\.com|ssh\.github\.com:443)\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      value
    )
  return match ? `${match[1]}/${match[2]}` : null
}
