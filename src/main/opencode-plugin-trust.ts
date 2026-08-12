import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

export interface OpenCodeProjectPluginMetadata {
  path: string
  digest: string
  size: number
  contents: Buffer
}

export interface OpenCodeProjectPluginAuthorization {
  cwd: string
  fingerprint: string
  plugins: OpenCodeProjectPluginMetadata[]
}

interface OpenCodePluginGrantRecord {
  cwd: string
  fingerprint: string
  pluginCount: number
  updatedAt: number
}

interface OpenCodePluginGrantFile {
  version: 1
  grants: OpenCodePluginGrantRecord[]
}

function canonicalCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd)
  } catch {
    return resolve(cwd)
  }
}

function readGrantFile(file: string): OpenCodePluginGrantFile {
  let fd: number | undefined
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) !== 0) return { version: 1, grants: [] }
    const value = JSON.parse(readFileSync(fd, 'utf8')) as Partial<OpenCodePluginGrantFile>
    return {
      version: 1,
      grants: Array.isArray(value.grants)
        ? value.grants.filter(
            (grant): grant is OpenCodePluginGrantRecord =>
              !!grant &&
              typeof grant.cwd === 'string' &&
              typeof grant.fingerprint === 'string' &&
              typeof grant.pluginCount === 'number' &&
              typeof grant.updatedAt === 'number'
          )
        : []
    }
  } catch {
    return { version: 1, grants: [] }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function openCodeProjectPluginFingerprint(plugins: OpenCodeProjectPluginMetadata[]): string {
  const payload = plugins
    .map((plugin) => `${plugin.path}\0${plugin.digest}\0${plugin.size}`)
    .join('\n')
  return `sha256:${createHash('sha256').update(`scry-opencode-project-plugins-v1\n${payload}`).digest('hex')}`
}

export function createOpenCodePluginGrantStore(userDataDir: string) {
  const file = join(userDataDir, 'opencode-plugin-grants.json')

  const isGranted = (cwd: string, fingerprint: string): boolean => {
    const canonical = canonicalCwd(cwd)
    return readGrantFile(file).grants.some(
      (grant) => grant.cwd === canonical && grant.fingerprint === fingerprint
    )
  }

  const grant = (cwd: string, fingerprint: string, pluginCount: number): void => {
    const canonical = canonicalCwd(cwd)
    const current = readGrantFile(file)
    const next: OpenCodePluginGrantFile = {
      version: 1,
      grants: [
        ...current.grants.filter((item) => item.cwd !== canonical),
        { cwd: canonical, fingerprint, pluginCount, updatedAt: Date.now() }
      ]
    }
    const temporary = join(userDataDir, `.opencode-plugin-grants-${process.pid}-${Date.now()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, file)
    chmodSync(file, 0o600)
  }

  return { isGranted, grant }
}
