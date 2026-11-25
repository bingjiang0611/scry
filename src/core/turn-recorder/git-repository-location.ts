import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TurnDiffSnapshot } from '../../shared/turn-diff.js'
import {
  isRepositoryBranch, isRepositoryCommit, isRepositoryRemote, TURN_REPOSITORY_LOCATION_LIMITS,
  type RepositoryBranchStatus, type RepositoryCommitStatus, type RepositoryRemoteStatus,
  type TurnRepositoryLocation
} from '../../shared/turn-repository-location.js'

const SMALL_FILE_BYTES = 4096
const CONFIG_BYTES = 64 * 1024
const PACKED_REFS_BYTES = 256 * 1024

/** `git status --branch` reports this literal branch head when HEAD holds a commit. */
export const DETACHED_BRANCH_HEAD = '(detached)'

/**
 * The finish-time retry only runs for repositories this turn changed, and it owns its own pool: the
 * shared `pending` counter exists to keep a turn's start sampling bounded, and reusing it would make
 * the retry inherit exactly the drop that left the location incomplete.
 *
 * `perRepositoryMs` bounds one repository's read. `turnMs` is the one deadline a whole turn shares
 * (`collectTurnDiffs` computes it once), so the host's Stop hook waits a constant at most: `turnMs`
 * plus the reads already inside it, whatever the repository count. The retry runs on the hook's
 * synchronous path, which is why the ceiling cannot be per repository.
 */
export const REPOSITORY_REMOTE_RETRY = { perRepositoryMs: 250, pool: 8, turnMs: 500 } as const

export interface GitRepositoryHead {
  branch?: string | null
  commit?: string
}

export interface GitRepositoryLocation extends GitRepositoryHead {
  remote?: string
  remoteStatus?: RepositoryRemoteStatus
  branchStatus?: RepositoryBranchStatus
  commitStatus?: RepositoryCommitStatus
}

async function readSmallFile(path: string, limit: number, deadline: number): Promise<string | null | undefined> {
  if (Date.now() >= deadline) return undefined
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > limit || Date.now() >= deadline) return undefined
      const buffer = Buffer.alloc(info.size + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead !== info.size || Date.now() >= deadline) return undefined
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
}

export function normalizeGitOrigin(raw: string): string | undefined {
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return undefined
  let host: string
  let path: string
  if (/^(?:https?|ssh|git):\/\//i.test(raw)) {
    let url: URL
    try { url = new URL(raw) } catch { return undefined }
    if (!url.hostname) return undefined
    host = url.host.toLowerCase()
    path = /^\w+:\/\/[^/?#]+\/([^?#]*)/i.exec(raw)?.[1] ?? ''
    if (path && url.pathname !== `/${path}`) return undefined
    if ((url.protocol === 'ssh:' && url.port === '22') || (url.protocol === 'git:' && url.port === '9418')) {
      host = url.hostname.toLowerCase()
    }
  } else {
    const scp = /^(?:[\w.+-]+@)?(\[[0-9a-fA-F:.]+\]|[\w.-]+):\/?([^?#]+)/.exec(raw)
    if (!scp || raw.includes('://') || /^(?:[a-z]|https?|ssh|git|file|ext)$/i.test(scp[1])) return undefined
    host = scp[1].toLowerCase()
    path = scp[2]
  }
  const remote = `${host}/${path.replace(/\/+$/, '').replace(/\.git$/, '')}`
  return isRepositoryRemote(remote) ? remote : undefined
}

function readOrigin(config: string): { remote?: string; status: 'observed' | 'absent' | 'unsupported' } {
  let inOrigin = false
  for (const line of config.split(/\r?\n/)) {
    if (line.endsWith('\\')) return { status: 'unsupported' } // Git continuations are outside this parser's subset.
    if (/^\s*\[/.test(line)) {
      const section = /^\s*\[remote(?:\s+"([^"]+)"|\.origin)\]\s*(?:[#;].*)?$/i.exec(line)
      inOrigin = !!section && (section[1] === undefined || section[1] === 'origin')
    } else if (inOrigin && /^\s*url\s*=/i.test(line)) {
      const value = /^\s*url\s*=\s*(?:"([^"\\]*)"\s*(?:[#;].*)?|([^\s"\\]+)(?:\s+[#;].*)?)\s*$/i.exec(line)
      const remote = value ? normalizeGitOrigin(value[1] ?? value[2]) : undefined
      // A local path or a token-only URL is a configured remote this build cannot name.
      return remote ? { remote, status: 'observed' } : { status: 'unsupported' }
    }
  }
  return { status: 'absent' }
}

async function readHead(gitDir: string, commonDir: string, deadline: number, publish: (head: GitRepositoryLocation) => void): Promise<void> {
  const head = (await readSmallFile(join(gitDir, 'HEAD'), SMALL_FILE_BYTES, deadline))?.trim()
  if (isRepositoryCommit(head)) return publish({ branch: null, branchStatus: 'detached', commit: head, commitStatus: 'observed' })
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head ?? '')?.[1]
  if (!isRepositoryBranch(branch)) return publish({ branchStatus: 'unavailable', commitStatus: 'unavailable' })
  publish({ branch, branchStatus: 'observed' })
  const ref = `refs/heads/${branch}`
  const loose = await readSmallFile(join(commonDir, ref), SMALL_FILE_BYTES, deadline)
  let commit = loose?.trim()
  if (loose === null) {
    const packed = await readSmallFile(join(commonDir, 'packed-refs'), PACKED_REFS_BYTES, deadline)
    for (const line of packed?.split(/\r?\n/) ?? []) {
      const separator = line.indexOf(' ')
      if (separator > 0 && line.slice(separator + 1) === ref) {
        commit = line.slice(0, separator)
        break
      }
    }
  }
  publish(isRepositoryCommit(commit) ? { commit, commitStatus: 'observed' } : { commitStatus: 'unavailable' })
}

/** Undefined means the path is not a readable Git layout; no further read can be bounded. */
async function gitDirsOf(repoRoot: string, deadline: number): Promise<{ gitDir: string; commonDir: string } | undefined> {
  let gitDir = join(repoRoot, '.git')
  const dotGit = await lstat(gitDir).catch(() => undefined)
  if (!dotGit) return undefined
  if (dotGit.isFile()) {
    const pointer = (await readSmallFile(gitDir, SMALL_FILE_BYTES, deadline))?.trim()
    const target = /^gitdir: ([^\u0000\r\n]+)$/.exec(pointer ?? '')?.[1]
    if (!target) return undefined
    gitDir = resolve(repoRoot, target)
  } else if (!dotGit.isDirectory()) return undefined
  const common = await readSmallFile(join(gitDir, 'commondir'), SMALL_FILE_BYTES, deadline)
  if (common === undefined || (common !== null && !/^[^\u0000\r\n]+$/.test(common.trim()))) return undefined
  return { gitDir, commonDir: common === null ? gitDir : resolve(gitDir, common.trim()) }
}

export async function readGitRepositoryLocation(
  repoRoot: string, deadline: number, includeOrigin: boolean, publish: (evidence: GitRepositoryLocation) => void
): Promise<void> {
  if (Date.now() >= deadline) return
  const dirs = await gitDirsOf(repoRoot, deadline)
  if (!dirs) return
  const { gitDir, commonDir } = dirs
  await Promise.all([
    readHead(gitDir, commonDir, deadline, publish),
    includeOrigin ? readSmallFile(join(commonDir, 'config'), CONFIG_BYTES, deadline).then(config => {
      if (config === undefined) return publish({ remoteStatus: 'unavailable' })
      if (config === null) return publish({ remoteStatus: 'absent' })
      const origin = readOrigin(config)
      publish(origin.remote ? { remote: origin.remote, remoteStatus: 'observed' } : { remoteStatus: origin.status })
    }) : undefined
  ])
}

let pending = 0

export function sampleGitRepositoryLocation(repoRoot: string, includeOrigin: boolean): () => GitRepositoryLocation {
  const location: GitRepositoryLocation = {}
  if (pending < TURN_REPOSITORY_LOCATION_LIMITS.repositories) {
    pending++
    void readGitRepositoryLocation(repoRoot, Date.now() + 50, includeOrigin, evidence => {
      Object.assign(location, evidence)
    }).catch(() => undefined).finally(() => { pending-- })
  }
  return () => ({ ...location })
}

let remotePending = 0
const remoteWaiters: Array<() => void> = []

/** Bounded by the turn ceiling even while queued, so a full pool cannot delay the host's Stop hook. */
async function withRemoteSlot<T>(turnDeadline: number, run: () => Promise<T>): Promise<T | undefined> {
  while (remotePending >= REPOSITORY_REMOTE_RETRY.pool) {
    if (Date.now() >= turnDeadline) return undefined
    await new Promise<void>(resolve => remoteWaiters.push(resolve))
  }
  remotePending++
  try {
    return await run()
  } finally {
    remotePending--
    remoteWaiters.shift()?.()
  }
}

/**
 * The origin identity a turn could not read at its start, retried once for a repository this turn
 * changed. Reads the same files as the start sample, with a larger budget and its own pool.
 */
export async function readTurnRepositoryRemote(
  repoRoot: string, turnDeadline: number
): Promise<{ remote?: string; remoteStatus: RepositoryRemoteStatus }> {
  const result = await withRemoteSlot(turnDeadline, async () => {
    const deadline = Math.min(Date.now() + REPOSITORY_REMOTE_RETRY.perRepositoryMs, turnDeadline)
    if (Date.now() >= deadline) return { remoteStatus: 'unavailable' as const }
    const dirs = await gitDirsOf(repoRoot, deadline)
    if (!dirs) return { remoteStatus: 'unavailable' as const }
    const config = await readSmallFile(join(dirs.commonDir, 'config'), CONFIG_BYTES, deadline)
    if (config === undefined) return { remoteStatus: 'unavailable' as const }
    if (config === null) return { remoteStatus: 'absent' as const }
    const origin = readOrigin(config)
    return origin.remote ? { remote: origin.remote, remoteStatus: 'observed' as const } : { remoteStatus: origin.status }
  })
  return result ?? { remoteStatus: 'unavailable' }
}

/** The HEAD and branch head this capture's own `git status` read, independent of the location sample. */
export interface GitRepositoryStart {
  head?: string
  branchHead?: string
}

/**
 * Location a record can defend. Values come from the start sample and the end read; the start HEAD
 * and branch the capture already holds fill what the 50 ms sample lost, and each field keeps a status
 * so "this repository has no origin" never reads the same as "the read did not finish".
 *
 * A status always describes the value this object finally carries, never the sample it came from: the
 * sample publishes `unavailable` before the backfill runs, so deriving a status from that first would
 * report "not read" next to a value that is right there. Value first, sample second, `unavailable`
 * last.
 */
export function withRepositoryLocation(
  snapshot: TurnDiffSnapshot, before?: GitRepositoryLocation, after?: GitRepositoryHead, start?: GitRepositoryStart
): TurnDiffSnapshot {
  const remote = before?.remote
  const branch = before?.branch !== undefined
    ? before.branch
    : start?.branchHead === DETACHED_BRANCH_HEAD ? null
      : isRepositoryBranch(start?.branchHead) ? start.branchHead : undefined
  const commitBefore = before?.commit ?? (isRepositoryCommit(start?.head) ? start.head : undefined)
  const remoteStatus: RepositoryRemoteStatus = remote
    ? 'observed'
    : before?.remoteStatus && before.remoteStatus !== 'observed' ? before.remoteStatus : 'unavailable'
  const branchStatus: RepositoryBranchStatus = typeof branch === 'string' ? 'observed' : branch === null ? 'detached' : 'unavailable'
  const commitStatus: RepositoryCommitStatus = commitBefore ? 'observed' : 'unavailable'
  const repositoryLocation: TurnRepositoryLocation = {
    ...(remote ? { remote } : {}),
    remoteStatus,
    ...(branch !== undefined ? { branch } : {}),
    branchStatus,
    commitStatus,
    ...(commitBefore ? { commitBefore } : {}),
    ...(after?.branch !== undefined ? { branchAfter: after.branch } : {}),
    ...(after?.commit ? { commitAfter: after.commit } : {})
  }
  return { ...snapshot, repositoryLocation }
}
