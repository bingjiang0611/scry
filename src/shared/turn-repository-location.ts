export const TURN_REPOSITORY_LOCATION_LIMITS = {
  repositories: 32,
  remoteBytes: 1024,
  branchBytes: 255,
  commitBytes: 64
} as const

export interface TurnRepositoryLocation {
  /** Origin identity, without transport, credentials, query, fragment or a trailing .git. */
  remote?: string
  /** Branch at turn start; null means HEAD was detached, absence means unknown. */
  branch?: string | null
  commitBefore?: string
  commitAfter?: string
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
  if (isRepositoryCommit(raw.commitBefore)) location.commitBefore = raw.commitBefore
  if (isRepositoryCommit(raw.commitAfter)) location.commitAfter = raw.commitAfter
  return Object.keys(location).length ? location : undefined
}
