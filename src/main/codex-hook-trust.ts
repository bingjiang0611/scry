import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type CodexHookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified'

export interface CodexHookMetadata {
  key: string
  eventName: string
  source: string
  sourcePath: string
  enabled: boolean
  currentHash: string
  trustStatus: CodexHookTrustStatus
}

export interface CodexHookInspection {
  cwd: string
  hooks: CodexHookMetadata[]
  warnings: string[]
  errors: string[]
}

export interface CodexHookTrustGrant {
  key: string
  currentHash: string
}

interface CodexHookGrant {
  cwd: string
  fingerprint: string
  hookCount: number
  updatedAt: number
}

interface CodexHookGrantFile {
  version: 1
  grants: CodexHookGrant[]
}

function canonicalCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd)
  } catch {
    return resolve(cwd)
  }
}

function readGrantFile(file: string): CodexHookGrantFile {
  try {
    if (!existsSync(file)) return { version: 1, grants: [] }
    const stat = lstatSync(file)
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== undefined && stat.uid !== uid)) {
      return { version: 1, grants: [] }
    }
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<CodexHookGrantFile>
    return {
      version: 1,
      grants: Array.isArray(value.grants)
        ? value.grants.filter(
            (grant): grant is CodexHookGrant =>
              !!grant &&
              typeof grant.cwd === 'string' &&
              typeof grant.fingerprint === 'string' &&
              typeof grant.hookCount === 'number' &&
              typeof grant.updatedAt === 'number'
          )
        : []
    }
  } catch {
    return { version: 1, grants: [] }
  }
}

export function hooksRequiringBypass(hooks: CodexHookMetadata[]): CodexHookMetadata[] {
  return hooks.filter(
    (hook) => hook.enabled && (hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified')
  )
}

export function codexHookFingerprint(hooks: CodexHookMetadata[]): string {
  const payload = hooks
    .filter((hook) => hook.enabled)
    .map((hook) => `${hook.key}\0${hook.currentHash}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(`scry-codex-hooks-v1\n${payload}`).digest('hex')
}

export function createCodexHookGrantStore(userDataDir: string) {
  const file = join(userDataDir, 'codex-hook-grants.json')

  const isGranted = (cwd: string, fingerprint: string): boolean =>
    readGrantFile(file).grants.some(
      (grant) => grant.cwd === canonicalCwd(cwd) && grant.fingerprint === fingerprint
    )

  const grant = (cwd: string, fingerprint: string, hookCount: number): void => {
    const canonical = canonicalCwd(cwd)
    const current = readGrantFile(file)
    const next: CodexHookGrantFile = {
      version: 1,
      grants: [
        ...current.grants.filter((item) => item.cwd !== canonical),
        { cwd: canonical, fingerprint, hookCount, updatedAt: Date.now() }
      ]
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, file)
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch { /* temporary may already be renamed */ }
      throw error
    }
  }

  return { isGranted, grant }
}
