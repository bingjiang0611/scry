import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants as fsConstants, existsSync, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import { Agent as UndiciAgent, type Dispatcher } from 'undici'
import { runtimeCliEnv } from '../claude-locate'
import { authorizedMcpServers, isRemoteMcpConfig } from '../mcp-config'
import type { AuthorizedMcpExecution } from './types'
import {
  openCodeProjectPluginFingerprint,
  type OpenCodeProjectPluginMetadata,
  type OpenCodeProjectPluginAuthorization
} from '../opencode-plugin-trust'

export const OPEN_CODE_LONG_REQUEST_TIMEOUTS = {
  headersTimeout: 0,
  bodyTimeout: 0
} as const

const LONG_REQUEST_PATH = /^\/session\/[^/]+\/(?:command|message)$/

export function createOpenCodeFetch(
  dispatcher: Dispatcher,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  return (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const longRunning = request.method === 'POST' && LONG_REQUEST_PATH.test(new URL(request.url).pathname)
    return longRunning
      ? fetchImpl(request, { dispatcher } as unknown as RequestInit)
      : fetchImpl(input, init)
  }
}

export function sanitizeOpenCodeServerLog(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(
      /\b((?:[A-Z0-9]+_)*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE))["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]'
    )
    .slice(-2_000)
}

export function sanitizeOpenCodeAuth(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const safe: Record<string, Record<string, unknown>> = {}
  for (const [provider, auth] of Object.entries(value)) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) continue
    const type = (auth as Record<string, unknown>).type
    if (type === 'api' || type === 'oauth') safe[provider] = { ...(auth as Record<string, unknown>) }
  }
  return safe
}

export function openCodeMcpAuthFile(env: NodeJS.ProcessEnv): string {
  const configuredDataHome = env.XDG_DATA_HOME?.trim()
  const dataHome = configuredDataHome && isAbsolute(configuredDataHome)
    ? configuredDataHome
    : join(env.HOME?.trim() || userInfo().homedir, '.local', 'share')
  return join(dataHome, 'opencode', 'mcp-auth.json')
}

const openCodeMcpAuthWrites = new Map<string, Promise<void>>()
const OPEN_CODE_MCP_AUTH_WRITE_ATTEMPTS = 5

function parseOpenCodeMcpAuth(contents: Buffer, source: string): Record<string, unknown> {
  try {
    const value = JSON.parse(contents.toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
    return value as Record<string, unknown>
  } catch {
    throw new Error(`OpenCode MCP OAuth 凭据文件格式无效：${source}`)
  }
}

async function readOptionalOpenCodeMcpAuth(source: string): Promise<Record<string, unknown> | null> {
  try {
    return parseOpenCodeMcpAuth(await readFile(source), source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)])
  )
}

type OpenCodeMcpTarget = AuthorizedMcpExecution['targets'][number]

function digestOpenCodeMcpIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex')
}

export function openCodeMcpCredentialKey(cwd: string, target: OpenCodeMcpTarget): string {
  return digestOpenCodeMcpIdentity({ cwd, targetId: target.targetId })
}

function privateOpenCodeMcpAuthFile(directory: string, cwd: string, target: OpenCodeMcpTarget): string {
  return join(directory, `${openCodeMcpCredentialKey(cwd, target)}.json`)
}

interface PrivateOpenCodeMcpAuth {
  version: 1
  workspaceDigest: string
  targetId: string
  configDigest: string
  serverName: string
  credential: unknown
}

function openCodeMcpWorkspaceDigest(cwd: string): string {
  return digestOpenCodeMcpIdentity({ cwd })
}

function openCodeMcpConfigDigest(target: OpenCodeMcpTarget): string {
  return digestOpenCodeMcpIdentity({ targetId: target.targetId, config: target.config })
}

function parsePrivateOpenCodeMcpAuth(contents: Buffer, source: string): PrivateOpenCodeMcpAuth {
  try {
    const value = JSON.parse(contents.toString('utf8')) as Record<string, unknown>
    if (
      value?.version !== 1
      || typeof value.workspaceDigest !== 'string'
      || typeof value.targetId !== 'string'
      || typeof value.configDigest !== 'string'
      || typeof value.serverName !== 'string'
      || !Object.hasOwn(value, 'credential')
    ) throw new Error('invalid envelope')
    return value as unknown as PrivateOpenCodeMcpAuth
  } catch {
    throw new Error(`Scry OpenCode MCP OAuth 凭据文件格式无效：${source}`)
  }
}

async function readOptionalPrivateOpenCodeMcpAuth(source: string): Promise<PrivateOpenCodeMcpAuth | null> {
  try {
    return parsePrivateOpenCodeMcpAuth(await readFile(source), source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function persistPrivateOpenCodeMcpAuth(
  source: string,
  directory: string,
  cwd: string,
  target: OpenCodeMcpTarget
): Promise<void> {
  const isolated = parseOpenCodeMcpAuth(await readFile(source), source)
  if (!Object.hasOwn(isolated, target.name)) {
    throw new Error(`OpenCode 未保存 MCP ${target.name} 的 OAuth 凭据`)
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = privateOpenCodeMcpAuthFile(directory, cwd, target)
  const previous = openCodeMcpAuthWrites.get(destination) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(async () => {
    const contents = Buffer.from(JSON.stringify({
      version: 1,
      workspaceDigest: openCodeMcpWorkspaceDigest(cwd),
      targetId: target.targetId,
      configDigest: openCodeMcpConfigDigest(target),
      serverName: target.name,
      credential: isolated[target.name]
    } satisfies PrivateOpenCodeMcpAuth))
    const temporary = `${destination}.scry-${randomBytes(8).toString('hex')}`
    try {
      await writeFile(temporary, contents, { mode: 0o600 })
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  })
  openCodeMcpAuthWrites.set(destination, write)
  try {
    await write
  } finally {
    if (openCodeMcpAuthWrites.get(destination) === write) openCodeMcpAuthWrites.delete(destination)
  }
}

/** Build an isolated Provider seed; Scry-private credentials are matched to exact workspace/config identities. */
export interface OpenCodeMcpAuthSeedOptions {
  /** Only a complete target inventory may prove that an omitted private credential is stale. */
  completeTargetInventory?: boolean
}

export async function openCodeMcpAuthSeed(
  providerFile: string,
  scryPrivateDirectory?: string,
  execution?: AuthorizedMcpExecution,
  options: OpenCodeMcpAuthSeedOptions = {}
): Promise<Buffer | null> {
  // A Provider-global file has only server names, not endpoint identities. It is safe only in
  // legacy/non-App callers; production Scry uses its identity-bound private directory instead.
  const provider = scryPrivateDirectory ? null : await readOptionalOpenCodeMcpAuth(providerFile)
  const merged = { ...(provider ?? {}) }
  if (scryPrivateDirectory && execution) {
    const workspaceDigest = openCodeMcpWorkspaceDigest(execution.cwd)
    const targetsById = new Map(execution.targets.map((target) => [target.targetId, target]))
    for (const target of execution.targets.filter((item) => item.enabled)) {
      const path = privateOpenCodeMcpAuthFile(scryPrivateDirectory, execution.cwd, target)
      const managed = await readOptionalPrivateOpenCodeMcpAuth(path)
      if (!managed) continue
      if (
        managed.workspaceDigest !== workspaceDigest
        || managed.targetId !== target.targetId
        || managed.configDigest !== openCodeMcpConfigDigest(target)
        || managed.serverName !== target.name
      ) {
        await rm(path, { force: true })
        continue
      }
      merged[target.name] = managed.credential
    }
    if (options.completeTargetInventory !== false) {
      try {
        for (const name of await readdir(scryPrivateDirectory)) {
          if (!name.endsWith('.json')) continue
          const path = join(scryPrivateDirectory, name)
          let candidate: PrivateOpenCodeMcpAuth
          try {
            candidate = parsePrivateOpenCodeMcpAuth(await readFile(path), path)
          } catch {
            continue
          }
          if (candidate.workspaceDigest === workspaceDigest && !targetsById.has(candidate.targetId)) {
            await rm(path, { force: true })
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return Object.keys(merged).length > 0 ? Buffer.from(JSON.stringify(merged)) : null
}

export async function persistOpenCodeMcpAuth(
  source: string,
  destination: string,
  serverName: string
): Promise<void> {
  const previous = openCodeMcpAuthWrites.get(destination) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(async () => {
    const isolated = parseOpenCodeMcpAuth(await readFile(source), source)
    if (!Object.hasOwn(isolated, serverName)) {
      throw new Error(`OpenCode 未保存 MCP ${serverName} 的 OAuth 凭据`)
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    for (let attempt = 1; attempt <= OPEN_CODE_MCP_AUTH_WRITE_ATTEMPTS; attempt += 1) {
      let before: Buffer | null = null
      let current: Record<string, unknown> = {}
      try {
        before = await readFile(destination)
        current = parseOpenCodeMcpAuth(before, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const contents = Buffer.from(JSON.stringify({ ...current, [serverName]: isolated[serverName] }))
      const temporary = `${destination}.scry-${randomBytes(8).toString('hex')}`
      try {
        await writeFile(temporary, contents, { mode: 0o600 })
        let latest: Buffer | null = null
        try {
          latest = await readFile(destination)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const unchanged = before === null ? latest === null : latest !== null && before.equals(latest)
        if (!unchanged) {
          await rm(temporary, { force: true })
          if (attempt === OPEN_CODE_MCP_AUTH_WRITE_ATTEMPTS) {
            throw new Error('OpenCode MCP OAuth 凭据文件在写入期间持续变化，请重试')
          }
          continue
        }
        await rename(temporary, destination)
        return
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    }
  })
  openCodeMcpAuthWrites.set(destination, write)
  try {
    await write
  } finally {
    if (openCodeMcpAuthWrites.get(destination) === write) openCodeMcpAuthWrites.delete(destination)
  }
}

async function isolatedOpenCodeAuthContent(env: NodeJS.ProcessEnv): Promise<string> {
  const merged: Record<string, Record<string, unknown>> = {}
  const dataHome = dirname(openCodeMcpAuthFile(env))
  try {
    Object.assign(merged, sanitizeOpenCodeAuth(JSON.parse(await readFile(join(dataHome, 'auth.json'), 'utf8'))))
  } catch {
    // Missing or malformed source auth means the isolated process starts unauthenticated.
  }
  try {
    if (env.OPENCODE_AUTH_CONTENT) Object.assign(merged, sanitizeOpenCodeAuth(JSON.parse(env.OPENCODE_AUTH_CONTENT)))
  } catch {
    // Never forward malformed or unclassified inherited auth content.
  }
  return JSON.stringify(merged)
}

export function isolatedOpenCodeChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  root: string,
  configPath: string,
  configDir: string,
  authContent: string,
  serverPassword: string,
  sessionDatabasePath?: string,
  projectRoot?: string
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(sourceEnv).filter(
      ([key]) => !key.startsWith('OPENCODE_') && !key.startsWith('XDG_') && key !== 'SCRY_OPENCODE_PROJECT_ROOT'
    )
  )
  const openCodeApiKey = sourceEnv.OPENCODE_API_KEY?.trim()
  return {
    ...inherited,
    HOME: root,
    ...(openCodeApiKey ? { OPENCODE_API_KEY: openCodeApiKey } : {}),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CONFIG_DIRS: join(root, 'config-dirs'),
    XDG_DATA_DIRS: join(root, 'data-dirs'),
    OPENCODE_TEST_HOME: root,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, 'managed'),
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_AUTH_CONTENT: authContent,
    OPENCODE_DB: sessionDatabasePath ?? join(root, 'data', 'opencode.db'),
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_SERVER_PASSWORD: serverPassword,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    ...(projectRoot ? { SCRY_OPENCODE_PROJECT_ROOT: projectRoot } : {})
  }
}

async function ensurePrivateOpenCodeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const before = await lstat(path)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!before.isDirectory() || (uid !== undefined && before.uid !== uid)) {
    throw new Error(`OpenCode session state 目录不可信：${path}`)
  }
  await chmod(path, 0o700)
  const after = await lstat(path)
  if (!after.isDirectory() || (after.mode & 0o777) !== 0o700 || (uid !== undefined && after.uid !== uid)) {
    throw new Error(`OpenCode session state 目录权限不安全：${path}`)
  }
}

export async function openCodeSessionDatabase(stateRoot: string, cwd: string): Promise<string> {
  if (!isAbsolute(stateRoot)) throw new Error('OpenCode session state 根目录必须使用绝对路径')
  const canonicalCwd = await realpath(cwd)
  if (!(await stat(canonicalCwd)).isDirectory()) throw new Error('OpenCode 工作目录不是目录')
  await ensurePrivateOpenCodeDirectory(stateRoot)
  const workspaceDigest = createHash('sha256').update(canonicalCwd).digest('hex')
  const workspaceDirectory = join(stateRoot, workspaceDigest)
  await ensurePrivateOpenCodeDirectory(workspaceDirectory)
  const database = join(workspaceDirectory, 'opencode.db')
  let handle
  try {
    handle = await open(database, fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600)
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    const before = await handle.stat()
    if (!before.isFile() || (uid !== undefined && before.uid !== uid)) {
      throw new Error('OpenCode session database 不是 Scry 私有普通文件')
    }
    await handle.chmod(0o600)
    const after = await handle.stat()
    if (!after.isFile() || (after.mode & 0o777) !== 0o600 || (uid !== undefined && after.uid !== uid)) {
      throw new Error('OpenCode session database 权限不安全')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('OpenCode session database 不允许符号链接（symlink）')
    }
    throw error
  } finally {
    await handle?.close()
  }
  return database
}

export function openCodeServerAuthorization(serverPassword: string): string {
  return `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForOpenCodeHealth(
  url: string,
  authorization: string,
  child: ChildProcessWithoutNullStreams,
  startupError: () => Error | undefined
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const spawnError = startupError()
    if (spawnError) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`OpenCode server exited (${child.exitCode ?? child.signalCode ?? 'unknown'})`)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 500)
    try {
      const response = await fetch(`${url}/global/health`, {
        headers: { Authorization: authorization },
        signal: controller.signal
      })
      if (response.ok) return
    } catch {
      // The fixed local port may refuse connections until the child finishes binding.
    } finally {
      clearTimeout(timeout)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('OpenCode server 启动超时：本地健康检查在 10 秒内未就绪')
}

export interface OpenCodeServerState {
  cwd: string
  mcpFingerprint: string
  projectFingerprint?: string
  projectContentFingerprint?: string
  projectPluginFingerprint?: string
  hookTracePath?: string
  url: string
  pid?: number
  client: OpencodeClient
}

export interface OpenCodeServerExitDiagnostic {
  at: number
  code: number | null
  signal: NodeJS.Signals | null
  expected: boolean
}

export interface OpenCodeServerDiagnostic {
  running: boolean
  pid?: number
  lastExit?: OpenCodeServerExitDiagnostic
}

export function openCodeMcpConfig(execution?: AuthorizedMcpExecution): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(authorizedMcpServers(execution)).map(([name, config]) => {
      if (isRemoteMcpConfig(config)) {
        return [name, {
          type: 'remote',
          url: config.url,
          ...(config.headers && typeof config.headers === 'object' ? { headers: config.headers } : {}),
          ...(Object.hasOwn(config, 'oauth') ? { oauth: config.oauth } : {}),
          ...(typeof config.timeout === 'number' ? { timeout: config.timeout } : {}),
          enabled: true
        }]
      }
      return [name, {
        type: 'local',
        command: [String(config.command ?? ''), ...(Array.isArray(config.args) ? config.args.map(String) : [])],
        ...(config.env && typeof config.env === 'object' ? { environment: config.env } : {}),
        ...(typeof config.timeout === 'number' ? { timeout: config.timeout } : {}),
        enabled: true
      }]
    })
  )
}

const OPEN_CODE_PROJECT_CONFIG_LIMIT = 1_000_000
const OPEN_CODE_PROJECT_FILE_LIMIT = 4_000_000
const OPEN_CODE_PROJECT_TOTAL_LIMIT = 16_000_000
const OPEN_CODE_PROJECT_FILE_COUNT_LIMIT = 512

export interface OpenCodeProjectProjection {
  cwd: string
  instructions: string[]
  skillRoot?: string
  plugins: OpenCodeProjectPluginMetadata[]
  pluginFingerprint: string
  fingerprint: string
  contentFingerprint: string
}

export class OpenCodeProjectPluginSecurityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OpenCodeProjectPluginSecurityError'
  }
}

function pluginSecurityError(message: string, cause?: unknown): OpenCodeProjectPluginSecurityError {
  return new OpenCodeProjectPluginSecurityError(message, {
    ...(cause instanceof Error ? { cause } : {})
  })
}

export interface OpenCodeHookTraceRecord {
  version: 1
  stage: 'hook_started' | 'hook_response'
  sessionId: string
  callId: string
  tool: string
  timestamp: string
  recordSha256: string
}

function pathWithin(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

async function assertNoProjectSymlink(root: string, candidate: string): Promise<void> {
  const suffix = relative(root, candidate)
  if (!pathWithin(root, candidate)) throw new Error(`OpenCode 项目路径逃逸项目目录：${suffix}`)
  let current = root
  for (const segment of suffix.split(sep).filter(Boolean)) {
    current = join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`OpenCode 项目配置不允许符号链接（symlink）：${relative(root, current)}`)
    }
  }
}

async function projectFile(
  root: string,
  rawPath: unknown
): Promise<{ path: string; digest: string; size: number }> {
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) {
    throw new Error('OpenCode instruction 必须是可信的项目本地路径')
  }
  const source = rawPath.trim()
  const segments = source.split(/[\\/]+/)
  if (
    isAbsolute(source)
    || segments.includes('..')
    || /^(?:[a-z][a-z0-9+.-]*:|\\\\)/i.test(source)
    || /[*?\[\]{}]/.test(source)
  ) {
    throw new Error(`OpenCode instruction 路径必须是项目目录内的可信本地文件：${source}`)
  }
  const lexical = resolve(root, source)
  if (!pathWithin(root, lexical)) throw new Error(`OpenCode instruction 路径逃逸项目目录：${source}`)
  await assertNoProjectSymlink(root, lexical)
  const info = await stat(lexical)
  if (!info.isFile()) throw new Error(`OpenCode instruction 路径不是普通文件：${source}`)
  const extension = extname(lexical).toLowerCase()
  if (extension !== '.md') {
    throw new Error(`OpenCode instruction 仅允许项目内 Markdown 文件：${source}`)
  }
  if (info.size > OPEN_CODE_PROJECT_FILE_LIMIT) throw new Error(`OpenCode instruction 文件过大：${source}`)
  const canonical = await realpath(lexical)
  if (!pathWithin(root, canonical)) throw new Error(`OpenCode instruction 路径逃逸项目目录：${source}`)
  const contents = await readFile(canonical)
  return {
    path: canonical,
    digest: createHash('sha256').update(contents).digest('hex'),
    size: contents.length
  }
}

async function projectPluginFile(root: string, rawPath: unknown): Promise<OpenCodeProjectPluginMetadata> {
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) {
    throw pluginSecurityError('OpenCode plugin 必须是项目内本地相对普通文件')
  }
  const source = rawPath.trim()
  const segments = source.split(/[\\/]+/)
  if (
    !(source.startsWith('./') || source.startsWith('.\\'))
    || isAbsolute(source)
    || segments.includes('..')
    || /^(?:[a-z][a-z0-9+.-]*:|\\\\)/i.test(source)
    || /[*?\[\]{}]/.test(source)
  ) {
    throw pluginSecurityError(`OpenCode plugin 仅允许 ./ 开头的项目内本地相对文件，拒绝 URL、package 或逃逸路径：${source}`)
  }
  const lexical = resolve(root, source)
  if (!pathWithin(root, lexical)) throw pluginSecurityError(`OpenCode plugin 路径逃逸项目目录：${source}`)
  try {
    await assertNoProjectSymlink(root, lexical)
  } catch (error) {
    throw pluginSecurityError(
      `OpenCode plugin 路径不可信：${source}（${error instanceof Error ? error.message : String(error)}）`,
      error
    )
  }
  let handle
  try {
    handle = await open(lexical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch (error) {
    throw pluginSecurityError(`OpenCode plugin 无法安全打开：${source}`, error)
  }
  try {
    let info
    try {
      info = await handle.stat()
    } catch (error) {
      throw pluginSecurityError(`OpenCode plugin 无法校验文件类型：${source}`, error)
    }
    if (!info.isFile()) throw pluginSecurityError(`OpenCode plugin 路径不是普通文件：${source}`)
    if (info.size > OPEN_CODE_PROJECT_FILE_LIMIT) throw pluginSecurityError(`OpenCode plugin 文件过大：${source}`)
    const contents = await handle.readFile()
    if (contents.length !== info.size) throw pluginSecurityError(`OpenCode plugin 读取期间发生变化：${source}`)
    const canonical = await realpath(lexical)
    if (!pathWithin(root, canonical)) throw pluginSecurityError(`OpenCode plugin 路径逃逸项目目录：${source}`)
    const canonicalInfo = await stat(canonical)
    if (canonicalInfo.dev !== info.dev || canonicalInfo.ino !== info.ino) {
      throw pluginSecurityError(`OpenCode plugin 路径在校验期间被替换：${source}`)
    }
    if (!['.js', '.mjs'].includes(extname(canonical).toLowerCase())) {
      throw pluginSecurityError(`OpenCode plugin 单文件快照仅支持 .js/.mjs：${source}`)
    }
    const pluginSource = contents.toString('utf8')
    if (/(?:\b(?:import|export)\s+(?:[^'"`;]+?\s+from\s+)?|\bimport\s*\()\s*['"`]\.{1,2}\//m.test(pluginSource)) {
      throw pluginSecurityError(`OpenCode plugin 单文件快照不支持相对 import/export：${source}`)
    }
    return {
      path: canonical,
      digest: createHash('sha256').update(contents).digest('hex'),
      size: contents.length,
      contents
    }
  } catch (error) {
    if (error instanceof OpenCodeProjectPluginSecurityError) throw error
    throw pluginSecurityError(`OpenCode plugin 安全校验失败：${source}`, error)
  } finally {
    await handle.close()
  }
}

async function projectSkillTree(root: string): Promise<{
  root?: string
  files: Array<{ path: string; digest: string; size: number }>
}> {
  const lexicalRoot = join(root, '.opencode', 'skills')
  let rootInfo
  try {
    rootInfo = await lstat(lexicalRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [] }
    throw error
  }
  if (rootInfo.isSymbolicLink()) throw new Error('OpenCode 项目 Skill 根目录不允许符号链接（symlink）')
  if (!rootInfo.isDirectory()) throw new Error('OpenCode 项目 Skill 根路径不是目录')
  const canonicalRoot = await realpath(lexicalRoot)
  if (!pathWithin(root, canonicalRoot)) throw new Error('OpenCode 项目 Skill 根目录逃逸项目目录')
  const files: Array<{ path: string; digest: string; size: number }> = []
  let totalSize = 0
  let entryCount = 0
  let hasSkill = false
  const visit = async (directory: string, depth = 0): Promise<void> => {
    if (depth > 20) throw new Error('OpenCode 项目 Skill 目录深度超限')
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      entryCount += 1
      if (entryCount > OPEN_CODE_PROJECT_FILE_COUNT_LIMIT) throw new Error('OpenCode 项目 Skill 条目数量超限')
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`OpenCode 项目 Skill 不允许符号链接（symlink）：${relative(root, path)}`)
      }
      if (entry.isDirectory()) {
        await visit(path, depth + 1)
        continue
      }
      if (!entry.isFile()) throw new Error(`OpenCode 项目 Skill 包含特殊文件：${relative(root, path)}`)
      const info = await stat(path)
      if (info.size > OPEN_CODE_PROJECT_FILE_LIMIT) throw new Error(`OpenCode 项目 Skill 文件过大：${relative(root, path)}`)
      totalSize += info.size
      if (totalSize > OPEN_CODE_PROJECT_TOTAL_LIMIT) throw new Error('OpenCode 项目 Skill 总大小超限')
      const canonical = await realpath(path)
      if (!pathWithin(canonicalRoot, canonical)) throw new Error(`OpenCode 项目 Skill 路径逃逸：${relative(root, path)}`)
      const contents = await readFile(canonical)
      files.push({
        path: canonical,
        digest: createHash('sha256').update(contents).digest('hex'),
        size: contents.length
      })
      if (entry.name === 'SKILL.md') hasSkill = true
    }
  }
  await visit(canonicalRoot)
  return hasSkill ? { root: canonicalRoot, files } : { files: [] }
}

function projectionFingerprint(
  cwd: string,
  instructions: string[],
  skillRoot: string | undefined,
  plugins: OpenCodeProjectPluginMetadata[],
  files: Map<string, { digest: string; size: number }>
): { fingerprint: string; contentFingerprint: string } {
  const manifest = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => ({ path: relative(cwd, path), ...value }))
  const structure = {
    instructions: instructions.map((path) => relative(cwd, path)),
    skillRoot: skillRoot ? relative(cwd, skillRoot) : null,
    plugins: plugins.map((plugin) => relative(cwd, plugin.path))
  }
  return {
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(structure)).digest('hex')}`,
    contentFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`
  }
}

export async function readOpenCodeProjectProjection(cwd: string): Promise<OpenCodeProjectProjection> {
  const canonicalCwd = await realpath(cwd)
  if (!(await stat(canonicalCwd)).isDirectory()) throw new Error('OpenCode 工作目录不是目录')
  const configPath = join(canonicalCwd, 'opencode.json')
  let config: Record<string, unknown> = {}
  try {
    const configInfo = await lstat(configPath)
    if (configInfo.isSymbolicLink()) throw new Error('OpenCode 项目配置不允许符号链接（symlink）：opencode.json')
    if (!configInfo.isFile()) throw new Error('OpenCode 项目配置不是普通文件：opencode.json')
    if (configInfo.size > OPEN_CODE_PROJECT_CONFIG_LIMIT) throw new Error('OpenCode 项目配置文件过大')
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected object')
    config = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new Error('OpenCode 项目配置不是有效 JSON')
      throw error
    }
  }

  if (config.instructions !== undefined && !Array.isArray(config.instructions)) {
    throw new Error('OpenCode 项目 instructions 必须是路径数组')
  }
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
    throw pluginSecurityError('OpenCode 项目 plugin 必须是路径数组')
  }
  const files = new Map<string, { digest: string; size: number }>()
  const instructions: string[] = []
  for (const item of config.instructions ?? []) {
    const file = await projectFile(canonicalCwd, item)
    if (!instructions.includes(file.path)) instructions.push(file.path)
    files.set(file.path, { digest: file.digest, size: file.size })
  }
  const plugins: OpenCodeProjectPluginMetadata[] = []
  for (const item of config.plugin ?? []) {
    const plugin = await projectPluginFile(canonicalCwd, item)
    if (!plugins.some((candidate) => candidate.path === plugin.path)) plugins.push(plugin)
    files.set(plugin.path, { digest: plugin.digest, size: plugin.size })
  }
  const skills = await projectSkillTree(canonicalCwd)
  for (const file of skills.files) files.set(file.path, { digest: file.digest, size: file.size })
  const totalSize = [...files.values()].reduce((sum, file) => sum + file.size, 0)
  if (totalSize > OPEN_CODE_PROJECT_TOTAL_LIMIT) throw new Error('OpenCode 项目配置投影总大小超限')
  const fingerprints = projectionFingerprint(canonicalCwd, instructions, skills.root, plugins, files)
  return {
    cwd: canonicalCwd,
    instructions,
    plugins,
    pluginFingerprint: openCodeProjectPluginFingerprint(plugins),
    ...(skills.root ? { skillRoot: skills.root } : {}),
    ...fingerprints
  }
}

export async function assertOpenCodeProjectProjection(projection: OpenCodeProjectProjection): Promise<void> {
  const current = await readOpenCodeProjectProjection(projection.cwd)
  if (current.pluginFingerprint !== projection.pluginFingerprint) {
    throw pluginSecurityError('OpenCode 项目 plugin 声明或内容已变化，原授权失效')
  }
  if (
    current.fingerprint !== projection.fingerprint
    || current.contentFingerprint !== projection.contentFingerprint
  ) {
    throw new Error('OpenCode 项目配置投影 hash/fingerprint 已变化，拒绝继续启动')
  }
}

function assertOpenCodePluginAuthorization(
  projection: OpenCodeProjectProjection,
  authorization: OpenCodeProjectPluginAuthorization
): void {
  if (authorization.cwd !== projection.cwd || authorization.fingerprint !== projection.pluginFingerprint) {
    throw pluginSecurityError('OpenCode 项目 plugin 授权与当前 canonical cwd/fingerprint 不匹配')
  }
  if (openCodeProjectPluginFingerprint(authorization.plugins) !== authorization.fingerprint) {
    throw pluginSecurityError('OpenCode 项目 plugin 授权载荷 fingerprint 无效')
  }
  if (authorization.plugins.length !== projection.plugins.length) {
    throw pluginSecurityError('OpenCode 项目 plugin 授权列表与当前声明不匹配')
  }
  authorization.plugins.forEach((plugin, index) => {
    const current = projection.plugins[index]
    const actualDigest = createHash('sha256').update(plugin.contents).digest('hex')
    if (
      !current
      || plugin.path !== current.path
      || plugin.digest !== current.digest
      || plugin.size !== current.size
      || plugin.size !== plugin.contents.length
      || actualDigest !== plugin.digest
    ) throw pluginSecurityError('OpenCode 项目 plugin 授权字节与当前投影不匹配')
  })
}

export async function writeOpenCodePluginSnapshots(
  directory: string,
  projection: OpenCodeProjectProjection,
  authorization?: OpenCodeProjectPluginAuthorization
): Promise<string[]> {
  if (!authorization) return []
  assertOpenCodePluginAuthorization(projection, authorization)
  const snapshotDir = join(directory, 'project-plugin-snapshots')
  await mkdir(snapshotDir, { mode: 0o700 })
  const snapshots: string[] = []
  for (const [index, plugin] of authorization.plugins.entries()) {
    const snapshot = join(snapshotDir, `plugin-${index}${extname(plugin.path).toLowerCase()}`)
    await writeFile(snapshot, plugin.contents, { flag: 'wx', mode: 0o600 })
    await chmod(snapshot, 0o600)
    const handle = await open(snapshot, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      const contents = await handle.readFile()
      if (
        !info.isFile()
        || (info.mode & 0o777) !== 0o600
        || contents.length !== plugin.size
        || createHash('sha256').update(contents).digest('hex') !== plugin.digest
      ) throw new Error('Scry OpenCode plugin 快照完整性校验失败')
    } finally {
      await handle.close()
    }
    snapshots.push(snapshot)
  }
  return snapshots
}

export function openCodeSafeConfig(
  execution: AuthorizedMcpExecution | undefined,
  projection: OpenCodeProjectProjection,
  observerPluginPath: string,
  pluginSnapshots: string[] = []
): Record<string, unknown> {
  if (!isAbsolute(observerPluginPath)) throw new Error('Scry OpenCode observer plugin 必须使用绝对路径')
  if (pluginSnapshots.some((path) => !isAbsolute(path))) throw new Error('Scry OpenCode plugin 快照必须使用绝对路径')
  return {
    mcp: openCodeMcpConfig(execution),
    ...(projection.instructions.length > 0 ? { instructions: projection.instructions } : {}),
    ...(projection.skillRoot ? { skills: { paths: [projection.skillRoot] } } : {}),
    plugin: [pathToFileURL(observerPluginPath).href, ...pluginSnapshots.map((path) => pathToFileURL(path).href)]
  }
}

export function openCodeHookObserverSource(tracePath: string): string {
  return `import { appendFile } from "node:fs/promises"

const tracePath = ${JSON.stringify(tracePath)}
const text = (value) => typeof value === "string" && value.length > 0 ? value.slice(0, 512) : null
const record = async (stage, input = {}) => {
  const sessionId = text(input.sessionID) ?? text(input.sessionId) ?? text(input.session_id)
  const callId = text(input.callID) ?? text(input.callId) ?? text(input.call_id)
  const tool = text(input.tool) ?? text(input.toolName) ?? text(input.name)
  if (!sessionId || !callId || !tool) return
  const line = JSON.stringify({ version: 1, stage, sessionId, callId, tool, timestamp: new Date().toISOString() }) + "\\n"
  try { await appendFile(tracePath, line, { encoding: "utf8", mode: 0o600 }) } catch {}
}

export const ScryHookObserver = async () => ({
  "tool.execute.before": async (input) => record("hook_started", input),
  "tool.execute.after": async (input) => record("hook_response", input),
})
`
}

const OPEN_CODE_HOOK_TRACE_TURN_LIMIT = 4 * 1024 * 1024

function assertOpenCodeHookTraceFile(info: Stats): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (uid !== undefined && info.uid !== uid)) {
    throw new Error('OpenCode Hook trace 不是 Scry 私有普通文件')
  }
}

export async function openCodeHookTraceCursor(path?: string): Promise<number> {
  if (!path) return 0
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    assertOpenCodeHookTraceFile(info)
    return info.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('OpenCode Hook trace 文件缺失')
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('OpenCode Hook trace 不是可信普通文件')
    throw error
  } finally {
    await handle?.close()
  }
}

export async function readOpenCodeHookTrace(path: string, offset: number): Promise<OpenCodeHookTraceRecord[]> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('OpenCode Hook trace cursor 无效')
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    assertOpenCodeHookTraceFile(info)
    if (offset > info.size) throw new Error('OpenCode Hook trace 在当前 turn 内被截断')
    const length = info.size - offset
    if (length > OPEN_CODE_HOOK_TRACE_TURN_LIMIT) throw new Error('OpenCode Hook trace 当前 turn 数据超过 4 MiB 上限')
    const contents = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const result = await handle.read(contents, read, length - read, offset + read)
      if (result.bytesRead === 0) throw new Error('OpenCode Hook trace 在读取期间被截断')
      read += result.bytesRead
    }
    if (contents.length === 0) return []
    if (contents.at(-1) !== 0x0a) throw new Error('OpenCode Hook trace 包含未完成记录')
    return contents.toString('utf8').split('\n').filter(Boolean).map((line): OpenCodeHookTraceRecord => {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        throw new Error('OpenCode Hook trace 包含无效 JSON')
      }
      const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
      if (
        item.version !== 1
        || (item.stage !== 'hook_started' && item.stage !== 'hook_response')
        || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 512
        || typeof item.callId !== 'string' || !item.callId || item.callId.length > 512
        || typeof item.tool !== 'string' || !item.tool || item.tool.length > 512
        || typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp))
      ) throw new Error('OpenCode Hook trace 记录格式无效')
      return {
        ...(item as unknown as Omit<OpenCodeHookTraceRecord, 'recordSha256'>),
        recordSha256: `sha256:${createHash('sha256').update(`${line}\n`).digest('hex')}`
      }
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('OpenCode Hook trace 文件缺失')
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('OpenCode Hook trace 不是可信普通文件')
    throw error
  } finally {
    await handle?.close()
  }
}

export class OpenCodeServerManager {
  private active: (OpenCodeServerState & {
    process: ChildProcessWithoutNullStreams
    dispatcher: Dispatcher
    mcpAuthFile: string
  }) | null = null
  private starting: Promise<OpenCodeServerState> | null = null
  private pendingChild: ChildProcessWithoutNullStreams | null = null
  private pendingDispatcher: Dispatcher | null = null
  private startGeneration = 0
  private hookConfigDir: string | null = null
  private lastExit: OpenCodeServerExitDiagnostic | undefined
  private readonly expectedStops = new WeakSet<ChildProcessWithoutNullStreams>()

  constructor(
    private readonly executable: () => string | undefined,
    private readonly privateMcpAuthDirectory?: string,
    private readonly mcpAuthSeedOptions: OpenCodeMcpAuthSeedOptions = {},
    private readonly sessionStateRoot?: string
  ) {}

  get state(): OpenCodeServerState | null {
    return this.active
  }

  get diagnostic(): OpenCodeServerDiagnostic {
    return {
      running: this.active?.process.exitCode === null,
      pid: this.active?.pid,
      lastExit: this.lastExit
    }
  }

  async ensure(
    cwd: string,
    mcpExecution?: AuthorizedMcpExecution,
    pluginTrust?: OpenCodeProjectPluginAuthorization
  ): Promise<OpenCodeServerState> {
    const projection = await readOpenCodeProjectProjection(cwd)
    if (pluginTrust && (
      pluginTrust.cwd !== projection.cwd || pluginTrust.fingerprint !== projection.pluginFingerprint
    )) throw pluginSecurityError('OpenCode 项目 plugin 授权已失效，拒绝启动')
    const pluginFingerprint = pluginTrust?.fingerprint ?? 'none'
    const mcpFingerprint = mcpExecution?.fingerprint ?? 'none'
    if (
      this.active?.cwd === projection.cwd
      && this.active.mcpFingerprint === mcpFingerprint
      && this.active.projectFingerprint === projection.fingerprint
      && this.active.projectContentFingerprint === projection.contentFingerprint
      && this.active.projectPluginFingerprint === pluginFingerprint
      && this.active.process.exitCode === null
    ) return this.active
    if (this.starting) {
      const starting = await this.starting
      if (
        starting.cwd === projection.cwd
        && starting.mcpFingerprint === mcpFingerprint
        && starting.projectFingerprint === projection.fingerprint
        && starting.projectContentFingerprint === projection.contentFingerprint
        && starting.projectPluginFingerprint === pluginFingerprint
      ) return starting
    }
    this.close()
    const starting = this.start(projection, this.startGeneration, mcpExecution, pluginTrust)
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = null
    }
  }

  async persistMcpAuth(target: OpenCodeMcpTarget, cwd: string): Promise<void> {
    const active = this.active
    const root = this.hookConfigDir
    if (!active || !root) throw new Error('OpenCode server 当前未运行，无法保存 MCP OAuth 凭据')
    const source = join(root, 'data', 'opencode', 'mcp-auth.json')
    if (this.privateMcpAuthDirectory) {
      await persistPrivateOpenCodeMcpAuth(source, this.privateMcpAuthDirectory, cwd, target)
      return
    }
    await persistOpenCodeMcpAuth(source, active.mcpAuthFile, target.name)
  }

  private async start(
    projection: OpenCodeProjectProjection,
    generation: number,
    mcpExecution?: AuthorizedMcpExecution,
    pluginTrust?: OpenCodeProjectPluginAuthorization
  ): Promise<OpenCodeServerState> {
    const cwd = projection.cwd
    await assertOpenCodeProjectProjection(projection)
    const executable = this.executable()
    if (!executable) throw new Error('OpenCode executable 未找到')
    if (process.platform === 'darwin') {
      const managedPreferences = [
        `/Library/Managed Preferences/${userInfo().username}/ai.opencode.managed.plist`,
        '/Library/Managed Preferences/ai.opencode.managed.plist'
      ]
      const configured = managedPreferences.find(existsSync)
      if (configured) throw new Error(`OpenCode managed config 无法安全隔离：${configured}`)
    }
    const port = await freePort()
    const sourceEnv = runtimeCliEnv()
    const providerMcpAuthFile = openCodeMcpAuthFile(sourceEnv)
    const mcpAuthFile = providerMcpAuthFile
    const mcpAuthSeed = await openCodeMcpAuthSeed(
      providerMcpAuthFile,
      this.privateMcpAuthDirectory,
      mcpExecution,
      this.mcpAuthSeedOptions
    )
    const isolatedAuthContent = await isolatedOpenCodeAuthContent(sourceEnv)
    const sessionDatabasePath = this.sessionStateRoot
      ? await openCodeSessionDatabase(this.sessionStateRoot, cwd)
      : undefined
    if (generation !== this.startGeneration) throw new Error('OpenCode server 启动已取消')
    this.hookConfigDir = await mkdtemp(join(tmpdir(), 'scry-opencode-'))
    let isolatedConfigPath: string
    let isolatedConfigDir: string
    let hookTracePath: string
    try {
      isolatedConfigDir = join(this.hookConfigDir, 'config')
      await mkdir(isolatedConfigDir, { mode: 0o700 })
      await Promise.all(['xdg-config', 'data', 'state', 'cache', 'runtime', 'config-dirs', 'data-dirs'].map((dir) =>
        mkdir(join(this.hookConfigDir!, dir), { mode: 0o700 })
      ))
      if (mcpAuthSeed) {
        const isolatedMcpAuthDir = join(this.hookConfigDir, 'data', 'opencode')
        await mkdir(isolatedMcpAuthDir, { recursive: true, mode: 0o700 })
        await writeFile(join(isolatedMcpAuthDir, 'mcp-auth.json'), mcpAuthSeed, { mode: 0o600 })
      }
      isolatedConfigPath = join(this.hookConfigDir, 'safe-config.json')
      hookTracePath = join(this.hookConfigDir, 'hook-trace.jsonl')
      const observerPluginPath = join(this.hookConfigDir, 'scry-hook-observer.mjs')
      await mkdir(join(this.hookConfigDir, 'managed'), { mode: 0o700 })
      await writeFile(hookTracePath, '', { mode: 0o600 })
      await writeFile(observerPluginPath, openCodeHookObserverSource(hookTracePath), { mode: 0o600 })
      const pluginSnapshots = await writeOpenCodePluginSnapshots(this.hookConfigDir, projection, pluginTrust)
      await writeFile(
        isolatedConfigPath,
        JSON.stringify(openCodeSafeConfig(mcpExecution, projection, observerPluginPath, pluginSnapshots)),
        { mode: 0o600 }
      )
      await assertOpenCodeProjectProjection(projection)
      if (generation !== this.startGeneration) throw new Error('OpenCode server 启动已取消')
    } catch (error) {
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      throw error
    }
    const serverPassword = randomBytes(32).toString('base64url')
    const authorization = openCodeServerAuthorization(serverPassword)
    const child = spawn(executable, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
      cwd,
      env: isolatedOpenCodeChildEnv(
        sourceEnv,
        this.hookConfigDir,
        isolatedConfigPath,
        isolatedConfigDir,
        isolatedAuthContent,
        serverPassword,
        sessionDatabasePath,
        cwd
      ),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.pendingChild = child
    let output = ''
    const inspect = (chunk: Buffer | string): void => {
      output = (output + String(chunk)).slice(-12_000)
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    let dispatcher: Dispatcher | undefined
    let spawnError: Error | undefined
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('exit', (code, signal) => {
      this.lastExit = {
        at: Date.now(),
        code,
        signal,
        expected: this.expectedStops.has(child)
      }
      if (this.active?.process === child) this.active = null
      if (this.pendingChild === child) this.pendingChild = null
      dispatcher?.destroy()
    })
    const url = `http://127.0.0.1:${port}`
    try {
      await waitForOpenCodeHealth(url, authorization, child, () => spawnError)
      await assertOpenCodeProjectProjection(projection)
      if (generation !== this.startGeneration || this.pendingChild !== child) {
        throw new Error('OpenCode server 启动已取消')
      }
    } catch (error) {
      this.expectedStops.add(child)
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM')
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      const detail = sanitizeOpenCodeServerLog(output).trim()
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `：${detail}` : ''}`, {
        cause: error instanceof Error ? error : undefined
      })
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const exit = child.exitCode ?? child.signalCode ?? 'unknown'
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      throw new Error(
        `OpenCode server exited before readiness commit (${exit}): ${sanitizeOpenCodeServerLog(output).trim()}`
      )
    }
    try {
      dispatcher = new UndiciAgent(OPEN_CODE_LONG_REQUEST_TIMEOUTS)
      this.pendingDispatcher = dispatcher
      const state = {
        cwd,
        mcpFingerprint: mcpExecution?.fingerprint ?? 'none',
        projectFingerprint: projection.fingerprint,
        projectContentFingerprint: projection.contentFingerprint,
        projectPluginFingerprint: pluginTrust?.fingerprint ?? 'none',
        hookTracePath,
        url,
        pid: child.pid,
        process: child,
        dispatcher,
        mcpAuthFile,
        client: createOpencodeClient({
          baseUrl: url,
          directory: cwd,
          headers: { Authorization: authorization },
          fetch: createOpenCodeFetch(dispatcher)
        })
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `OpenCode server exited during readiness commit (${child.exitCode ?? child.signalCode ?? 'unknown'})`
        )
      }
      this.lastExit = undefined
      this.active = state
      this.pendingChild = null
      this.pendingDispatcher = null
      return state
    } catch (error) {
      if (this.active?.process === child) this.active = null
      if (this.pendingChild === child) this.pendingChild = null
      if (this.pendingDispatcher === dispatcher) this.pendingDispatcher = null
      this.expectedStops.add(child)
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM')
      dispatcher?.destroy()
      const dir = this.hookConfigDir
      this.hookConfigDir = null
      if (dir) await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  close(): void {
    this.startGeneration += 1
    const active = this.active
    this.active = null
    if (active) {
      this.expectedStops.add(active.process)
      if (!active.process.killed && active.process.exitCode === null) active.process.kill('SIGTERM')
      active.dispatcher.destroy()
    }
    const pendingChild = this.pendingChild
    this.pendingChild = null
    if (pendingChild) {
      this.expectedStops.add(pendingChild)
      if (!pendingChild.killed && pendingChild.exitCode === null) pendingChild.kill('SIGTERM')
    }
    this.pendingDispatcher?.destroy()
    this.pendingDispatcher = null
    const dir = this.hookConfigDir
    this.hookConfigDir = null
    if (dir) void rm(dir, { recursive: true, force: true })
  }
}
