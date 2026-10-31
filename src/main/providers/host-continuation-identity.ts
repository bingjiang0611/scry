import { createHash } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ProviderContext } from '../../shared/provider'
import { runtimeCliEnv } from '../claude-locate'

/**
 * Native resume identity for the CLI-hosted Providers (Qoder / OpenCode).
 *
 * These CLIs persist sessions outside Scry's stores, so a continuation key must
 * be derived only from inputs that change where/how the native session is
 * resumed: canonical cwd, the actual executable, the config/auth root and the
 * hashed auth material the launch really uses. Nothing here talks to the network
 * or starts a model, all file access is asynchronous, and unreadable or
 * unprovable material fails closed. Raw credentials are hashed and never
 * returned or logged.
 */
export class HostIdentityUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostIdentityUnavailable'
  }
}

type RuntimeEnv = Readonly<Record<string, string | undefined>>

const MAX_AUTH_BYTES = 1024 * 1024
const EXECUTABLE_CHUNK_BYTES = 1024 * 1024
/** Enough for a Provider CLI plus its bundled re-launch path, never unbounded. */
const MAX_CACHED_EXECUTABLES = 4

interface FileStamp {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface ExecutableFingerprint {
  stamp: FileStamp
  digest: string
}

const executableFingerprints = new Map<string, ExecutableFingerprint>()
const executableReads = new Map<string, Promise<ExecutableFingerprint>>()

const hashBytes = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const digest = (material: readonly string[]): string => hashBytes(material.join('\n'))

function fileStamp(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): FileStamp {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path).catch(() => {
    throw new HostIdentityUnavailable(`${label} 不可解析`)
  })
  const info = await stat(canonical).catch(() => {
    throw new HostIdentityUnavailable(`${label} 不可读取`)
  })
  if (!info.isDirectory()) throw new HostIdentityUnavailable(`${label} 不是目录`)
  return canonical
}

const canonicalWorkspace = (cwd: string | undefined): Promise<string> =>
  canonicalDirectory(cwd ?? process.cwd(), 'Provider 工作目录')

/**
 * Content identity of the exact executable the adapter launches.
 *
 * Hashing a Provider CLI on every preview, send and dispatch is real work for a
 * file that usually never changes, so the digest is cached under the complete
 * dev/ino/size/mtime/ctime stamp and re-verified against the path afterwards.
 * Concurrent callers share one read; a changed file is re-hashed, never reused.
 */
async function executableIdentity(path: string | undefined): Promise<string> {
  if (!path) throw new HostIdentityUnavailable('Provider executable 不可用')
  const canonical = await realpath(path).catch(() => {
    throw new HostIdentityUnavailable('Provider executable 路径不可解析')
  })
  const info = await stat(canonical).catch(() => {
    throw new HostIdentityUnavailable('Provider executable 不可读取')
  })
  if (!info.isFile()) throw new HostIdentityUnavailable('Provider executable 不是普通文件')
  if ((info.mode & 0o111) === 0) throw new HostIdentityUnavailable('Provider executable 不可执行')
  const stamp = fileStamp(info)
  return `${canonical}\0${stamp.dev}\0${stamp.ino}\0${stamp.size}\0${stamp.mtimeMs}\0${await executableDigest(canonical, stamp)}`
}

async function executableDigest(canonical: string, stamp: FileStamp): Promise<string> {
  const cached = executableFingerprints.get(canonical)
  if (cached && sameStamp(cached.stamp, stamp)) {
    executableFingerprints.delete(canonical)
    executableFingerprints.set(canonical, cached)
    return cached.digest
  }
  const key = `${canonical}\0${stamp.dev}\0${stamp.ino}\0${stamp.size}\0${stamp.mtimeMs}\0${stamp.ctimeMs}`
  const pending = executableReads.get(key)
  if (pending) return (await pending).digest
  const read = hashExecutable(canonical, stamp)
  executableReads.set(key, read)
  try {
    const fingerprint = await read
    executableFingerprints.delete(canonical)
    executableFingerprints.set(canonical, fingerprint)
    while (executableFingerprints.size > MAX_CACHED_EXECUTABLES) {
      executableFingerprints.delete(executableFingerprints.keys().next().value!)
    }
    return fingerprint.digest
  } finally {
    executableReads.delete(key)
  }
}

/** Streams the bytes so a large CLI is never held in memory, then rechecks the stamp. */
async function hashExecutable(canonical: string, expected: FileStamp): Promise<ExecutableFingerprint> {
  const handle = await open(canonical, 'r').catch(() => {
    throw new HostIdentityUnavailable('Provider executable 不可读取')
  })
  try {
    const before = await handle.stat().catch(() => {
      throw new HostIdentityUnavailable('Provider executable 不可读取')
    })
    if (!sameStamp(fileStamp(before), expected)) {
      throw new HostIdentityUnavailable('Provider executable 在读取前发生变化')
    }
    const hash = createHash('sha256')
    let position = 0
    while (position < expected.size) {
      const chunk = Buffer.allocUnsafe(Math.min(EXECUTABLE_CHUNK_BYTES, expected.size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) throw new HostIdentityUnavailable('Provider executable 读取不完整')
      hash.update(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat().catch(() => {
      throw new HostIdentityUnavailable('Provider executable 不可读取')
    })
    const pathAfter = await stat(canonical).catch(() => {
      throw new HostIdentityUnavailable('Provider executable 不可读取')
    })
    if (!sameStamp(fileStamp(after), expected) || !sameStamp(fileStamp(pathAfter), expected)) {
      throw new HostIdentityUnavailable('Provider executable 在读取期间发生变化')
    }
    return { stamp: expected, digest: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

/**
 * Hash of the auth material at one proven path. A file that is absent is reported
 * as absent, which is different from a file that exists but cannot be verified.
 */
async function authFileIdentity(path: string, label: string): Promise<string | undefined> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw new HostIdentityUnavailable(`${label} 不可读取`)
  })
  if (!info) return undefined
  if (!info.isFile()) throw new HostIdentityUnavailable(`${label} 不是普通文件`)
  if (info.size > MAX_AUTH_BYTES) throw new HostIdentityUnavailable(`${label} 超出可验证大小`)
  const bytes = await readFile(path).catch(() => {
    throw new HostIdentityUnavailable(`${label} 不可读取`)
  })
  return `${path}\0${hashBytes(bytes)}`
}

function secretIdentity(env: RuntimeEnv, names: readonly string[]): string[] {
  return names.map((name) => {
    const value = env[name]
    return `${name}\0${value === undefined ? 'unset' : hashBytes(value)}`
  })
}

const resolvedAgainstWorkspace = (cwd: string, configured: string, label: string): Promise<string> =>
  canonicalDirectory(resolve(cwd, configured), label)

/** Qoder launches through `qodercliAuth()`, so its auth lives in the CLI's own root. */
const qoderLaunchEnv = (): RuntimeEnv => runtimeCliEnv(undefined, { providerId: 'qoder' })

/**
 * Qoder reads `QODER_CONFIG_DIR` (or `<QODER_CLI_HOME>/<homedir>/.qoder`) and keeps
 * the native transcript under that root's `projects/<cwd key>`; auth lives in
 * `.auth/user` and `oauth_creds.json` inside the same root. The SDK resolves those
 * credentials itself, so a launch without verifiable auth material cannot resume.
 */
export async function qoderContinuationKey(
  context: ProviderContext,
  homeDir: string,
  executable: string | undefined,
  runtimeEnv: RuntimeEnv = qoderLaunchEnv()
): Promise<string> {
  const cwd = await canonicalWorkspace(context.cwd)
  const cliHome = runtimeEnv.QODER_CLI_HOME?.trim()
    ? await resolvedAgainstWorkspace(cwd, runtimeEnv.QODER_CLI_HOME.trim(), 'Qoder CLI home')
    : await canonicalDirectory(homeDir, 'Qoder home')
  const configuredRoot = runtimeEnv.QODER_CONFIG_DIR?.trim()
  const configRoot = configuredRoot
    ? await resolvedAgainstWorkspace(cwd, configuredRoot, 'Qoder config root')
    : await canonicalDirectory(join(cliHome, '.qoder'), 'Qoder config root')
  const auth = [
    await authFileIdentity(join(configRoot, '.auth', 'user'), 'Qoder auth 状态'),
    await authFileIdentity(join(configRoot, 'oauth_creds.json'), 'Qoder OAuth 凭据')
  ].filter((value): value is string => value !== undefined)
  if (auth.length === 0) throw new HostIdentityUnavailable('Qoder 缺少可验证的认证状态')
  return `qoder:${digest([
    'scry-continuation-v2', 'qoder', cwd, context.agentProfileId ?? '',
    await executableIdentity(executable), cliHome, configRoot, ...auth.sort(),
    ...secretIdentity(runtimeEnv, [
      'QODER_CLI_HOME', 'QODER_CONFIG_DIR', 'QODER_PERSONAL_ACCESS_TOKEN', 'QODER_SERVICE_ACCOUNT_KEY'
    ])
  ])}`
}

export interface OpenCodeIdentityOptions {
  /** Host home used when HOME/XDG_DATA_HOME are unavailable. */
  homeDir: string
  privateMcpAuthDirectory?: string
  /** Scry-private session database root; the per-workspace database is derived from it. */
  sessionStateRoot?: string
  executable?: string
  /** Launch environment; defaults to the same sanitized login-shell env the CLI gets. */
  runtimeEnv?: NodeJS.ProcessEnv
}

const openCodeLaunchEnv = (): RuntimeEnv => runtimeCliEnv(undefined, { providerId: 'opencode' })

/** Source of the auth material the isolated OpenCode child receives (see `isolatedOpenCodeChildEnv`). */
function openCodeDataHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.XDG_DATA_HOME?.trim()
  return configured && configured.startsWith('/') ? configured : join(env.HOME?.trim() || homeDir, '.local', 'share')
}

/**
 * OpenCode resumes from its own session database, so identity covers the actual
 * executable, the data home that supplies the source `auth.json`, the auth
 * material and API key the isolated child receives, and the Scry-private session
 * database location. Inherited `OPENCODE_*`/`XDG_*` variables are stripped from the
 * child, so they are not identity inputs; the content they select is.
 *
 * An absent `auth.json` is a supported unauthenticated start, so it is recorded as
 * absent rather than failing. A file that exists but cannot be verified fails closed.
 */
export async function openCodeContinuationKey(
  context: ProviderContext,
  options: OpenCodeIdentityOptions
): Promise<string> {
  const env = options.runtimeEnv ?? openCodeLaunchEnv()
  const executable = options.executable ?? env.SCRY_OPENCODE_PATH?.trim()
  const cwd = await canonicalWorkspace(context.cwd)
  const dataHome = openCodeDataHome(env, options.homeDir)
  const auth = [
    (await authFileIdentity(join(dataHome, 'opencode', 'auth.json'), 'OpenCode auth 状态')) ?? 'auth.json\0absent',
    env.OPENCODE_AUTH_CONTENT === undefined ? undefined : `env:OPENCODE_AUTH_CONTENT\0${hashBytes(env.OPENCODE_AUTH_CONTENT)}`,
    env.OPENCODE_API_KEY?.trim() ? `env:OPENCODE_API_KEY\0${hashBytes(env.OPENCODE_API_KEY)}` : undefined
  ].filter((value): value is string => value !== undefined)
  const sessionRoot = options.sessionStateRoot ? resolve(options.sessionStateRoot) : undefined
  const sessionDatabase = sessionRoot ? join(sessionRoot, hashBytes(cwd), 'opencode.db') : 'no-session-root'
  return `opencode:${digest([
    'scry-continuation-v2', 'opencode', cwd, context.agentProfileId ?? '',
    await executableIdentity(executable), dataHome, sessionDatabase,
    options.privateMcpAuthDirectory ? resolve(options.privateMcpAuthDirectory) : 'no-private-mcp-auth',
    ...auth.sort()
  ])}`
}
