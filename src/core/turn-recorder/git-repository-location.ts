import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TurnDiffSnapshot } from '../../shared/turn-diff.js'
import {
  isRepositoryBranch, isRepositoryCommit, isRepositoryRemote, TURN_REPOSITORY_LOCATION_LIMITS,
  type TurnRepositoryLocation
} from '../../shared/turn-repository-location.js'

const SMALL_FILE_BYTES = 4096
const CONFIG_BYTES = 64 * 1024
const PACKED_REFS_BYTES = 256 * 1024

export interface GitRepositoryHead {
  branch?: string | null
  commit?: string
}

export interface GitRepositoryLocation extends GitRepositoryHead {
  remote?: string
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

function readOrigin(config: string): string | undefined {
  let inOrigin = false
  for (const line of config.split(/\r?\n/)) {
    if (line.endsWith('\\')) return undefined
    if (/^\s*\[/.test(line)) {
      const section = /^\s*\[remote(?:\s+"([^"]+)"|\.origin)\]\s*(?:[#;].*)?$/i.exec(line)
      inOrigin = !!section && (section[1] === undefined || section[1] === 'origin')
    } else if (inOrigin && /^\s*url\s*=/i.test(line)) {
      const value = /^\s*url\s*=\s*(?:"([^"\\]*)"\s*(?:[#;].*)?|([^\s"\\]+)(?:\s+[#;].*)?)\s*$/i.exec(line)
      return value ? normalizeGitOrigin(value[1] ?? value[2]) : undefined
    }
  }
  return undefined
}

async function readHead(gitDir: string, commonDir: string, deadline: number, publish: (head: GitRepositoryHead) => void): Promise<void> {
  const head = (await readSmallFile(join(gitDir, 'HEAD'), SMALL_FILE_BYTES, deadline))?.trim()
  if (isRepositoryCommit(head)) return publish({ branch: null, commit: head })
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head ?? '')?.[1]
  if (!isRepositoryBranch(branch)) return
  publish({ branch })
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
  if (isRepositoryCommit(commit)) publish({ commit })
}

export async function readGitRepositoryLocation(
  repoRoot: string, deadline: number, includeOrigin: boolean, publish: (evidence: GitRepositoryLocation) => void
): Promise<void> {
  if (Date.now() >= deadline) return
  let gitDir = join(repoRoot, '.git')
  const dotGit = await lstat(gitDir).catch(() => undefined)
  if (!dotGit) return
  if (dotGit.isFile()) {
    const pointer = (await readSmallFile(gitDir, SMALL_FILE_BYTES, deadline))?.trim()
    const target = /^gitdir: ([^\u0000\r\n]+)$/.exec(pointer ?? '')?.[1]
    if (!target) return
    gitDir = resolve(repoRoot, target)
  } else if (!dotGit.isDirectory()) return
  const common = await readSmallFile(join(gitDir, 'commondir'), SMALL_FILE_BYTES, deadline)
  if (common === undefined || (common !== null && !/^[^\u0000\r\n]+$/.test(common.trim()))) return
  const commonDir = common === null ? gitDir : resolve(gitDir, common.trim())
  await Promise.all([
    readHead(gitDir, commonDir, deadline, publish),
    includeOrigin ? readSmallFile(join(commonDir, 'config'), CONFIG_BYTES, deadline).then(config => {
      const remote = config && readOrigin(config)
      if (remote) publish({ remote })
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

export function withRepositoryLocation(
  snapshot: TurnDiffSnapshot, before?: GitRepositoryLocation, after?: GitRepositoryHead
): TurnDiffSnapshot {
  const repositoryLocation: TurnRepositoryLocation = {
    ...(before?.remote ? { remote: before.remote } : {}),
    ...(before?.branch !== undefined ? { branch: before.branch } : {}),
    ...(after?.branch !== undefined ? { branchAfter: after.branch } : {}),
    ...(before?.commit ? { commitBefore: before.commit } : {}),
    ...(after?.commit ? { commitAfter: after.commit } : {})
  }
  return Object.keys(repositoryLocation).length ? { ...snapshot, repositoryLocation } : snapshot
}
