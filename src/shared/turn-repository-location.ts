export const TURN_REPOSITORY_LOCATION_LIMITS = {
  repositories: 32,
  remoteBytes: 1024,
  branchBytes: 255,
  commitBytes: 64
} as const

/**
 * Why a location field has no value. Some absences are facts about the repository, others are a read
 * that did not finish; reporting only the absence made a repository without an origin
 * indistinguishable from a read that timed out.
 */
export const REPOSITORY_REMOTE_STATUSES = ['observed', 'absent', 'unsupported', 'unavailable'] as const
export type RepositoryRemoteStatus = typeof REPOSITORY_REMOTE_STATUSES[number]
export const REPOSITORY_BRANCH_STATUSES = ['observed', 'detached', 'unavailable'] as const
export type RepositoryBranchStatus = typeof REPOSITORY_BRANCH_STATUSES[number]
export const REPOSITORY_COMMIT_STATUSES = ['observed', 'unavailable'] as const
export type RepositoryCommitStatus = typeof REPOSITORY_COMMIT_STATUSES[number]

export interface TurnRepositoryLocation {
  /** Origin identity, without transport, credentials, query, fragment or a trailing .git. */
  remote?: string
  /**
   * `observed`: `remote` is present. `absent`: the config was read and names no origin.
   * `unsupported`: an origin exists but is not an accepted identity, such as a local path.
   * `unavailable`: the config could not be read within this build's budget.
   */
  remoteStatus?: RepositoryRemoteStatus
  /** Branch at turn start; null means HEAD was detached, absence means unknown. */
  branch?: string | null
  /** `observed`: `branch` is a name. `detached`: HEAD held a commit. `unavailable`: HEAD was not read. */
  branchStatus?: RepositoryBranchStatus
  /** Branch at turn end; null means HEAD was detached, absence means unknown. */
  branchAfter?: string | null
  commitBefore?: string
  commitAfter?: string
  /** `observed`: `commitBefore` is present. `unavailable`: the start HEAD was never read. */
  commitStatus?: RepositoryCommitStatus
}

const encoder = new TextEncoder()

export function isRepositoryRemote(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TURN_REPOSITORY_LOCATION_LIMITS.remoteBytes &&
    /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::[0-9]+)?\/[A-Za-z0-9._~/-]+$/.test(value) &&
    !value.split('/').some(part => part === '' || part === '.' || part === '..')
}

export function isRepositoryBranch(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= TURN_REPOSITORY_LOCATION_LIMITS.branchBytes &&
    encoder.encode(value).length <= TURN_REPOSITORY_LOCATION_LIMITS.branchBytes &&
    !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') &&
    !value.endsWith('.') && value !== '@' &&
    !value.split('/').some(part => part === '' || part.startsWith('.') || part.endsWith('.lock'))
}

export function isRepositoryCommit(value: unknown): value is string {
  return typeof value === 'string' && (value.length === 40 || value.length === TURN_REPOSITORY_LOCATION_LIMITS.commitBytes) &&
    !/[^0-9a-f]/.test(value)
}

export function normalizeTurnRepositoryLocation(value: unknown): TurnRepositoryLocation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const location: TurnRepositoryLocation = {}
  if (isRepositoryRemote(raw.remote)) location.remote = raw.remote
  if (raw.branch === null || isRepositoryBranch(raw.branch)) location.branch = raw.branch
  if (raw.branchAfter === null || isRepositoryBranch(raw.branchAfter)) location.branchAfter = raw.branchAfter
  if (isRepositoryCommit(raw.commitBefore)) location.commitBefore = raw.commitBefore
  if (isRepositoryCommit(raw.commitAfter)) location.commitAfter = raw.commitAfter
  if (REPOSITORY_REMOTE_STATUSES.includes(raw.remoteStatus as RepositoryRemoteStatus)) location.remoteStatus = raw.remoteStatus as RepositoryRemoteStatus
  if (REPOSITORY_BRANCH_STATUSES.includes(raw.branchStatus as RepositoryBranchStatus)) location.branchStatus = raw.branchStatus as RepositoryBranchStatus
  if (REPOSITORY_COMMIT_STATUSES.includes(raw.commitStatus as RepositoryCommitStatus)) location.commitStatus = raw.commitStatus as RepositoryCommitStatus
  return Object.keys(location).length ? location : undefined
}

/**
 * Write-side guard for the commit funnel, the counterpart of the tolerant read above. Readers drop a
 * status this build does not know so one newer record cannot invalidate every other section; the
 * writer must not introduce one, so `commitRecord` refuses it. Locations only live on diff entries.
 */
export function invalidRepositoryLocationStatuses(record: unknown): string[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return []
  const sections = [(record as Record<string, unknown>).diff]
  const found = new Set<string>()
  for (const section of sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue
    const value = (section as Record<string, unknown>).value
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const location = (entry as Record<string, unknown>).repositoryLocation
      if (!location || typeof location !== 'object' || Array.isArray(location)) continue
      const raw = location as Record<string, unknown>
      const known: Array<[string, readonly string[]]> = [
        ['remoteStatus', REPOSITORY_REMOTE_STATUSES],
        ['branchStatus', REPOSITORY_BRANCH_STATUSES],
        ['commitStatus', REPOSITORY_COMMIT_STATUSES]
      ]
      for (const [key, allowed] of known) {
        if (raw[key] === undefined) continue
        if (typeof raw[key] !== 'string' || !allowed.includes(raw[key] as string)) found.add(`${key}=${String(raw[key])}`)
      }
    }
  }
  return [...found]
}
