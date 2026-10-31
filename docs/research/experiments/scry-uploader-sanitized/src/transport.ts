import { createHash } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { TRANSPORT_TIMEOUT_SECONDS, MCP_SERVER, MCP_SKILL, MCP_TOOL } from './constants.js'
import { executable, object, run } from './util.js'

export interface Actor {
  userId: string
  nick: string
}

export type ArgumentStyle = 'named' | 'field_name' | 'positional'

export const TRANSPORT_INSTALL_URL = 'https://installer.invalid/install.sh'

function executableSync(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const CACHE_TTL_MS = 5 * 60_000
const actorCache = new Map<string, { expiresAt: number; value: Actor }>()
const styleCache = new Map<string, { expiresAt: number; value: ArgumentStyle }>()
async function authCacheKey(env: NodeJS.ProcessEnv): Promise<string> {
  const home = env.HOME || homedir()
  const executable = transportExecutable(env)
  const files = [executable, join(home, '.config', 'transport', 'auth.yaml'), join(home, '.config', 'transport', 'config.yaml')]
  const revisions = await Promise.all(files.map(async path => {
    try {
      const metadata = await stat(path, { bigint: true })
      return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  }))
  // Fingerprint identities/configuration, never persist credentials or cache
  // an account across a token/configuration change.
  return createHash('sha256').update(JSON.stringify([
    executable, home, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME,
    env.TRANSPORT_AUTH_PROVIDER, env.TRANSPORT_PROFILE, env.TRANSPORT_SERVICE_TOKEN, revisions
  ])).digest('hex')
}
function invalidateAuthCache(_env: NodeJS.ProcessEnv): void {
  // The CLI may update its auth file while failing; its old key is unknowable.
  actorCache.clear()
  styleCache.clear()
}

const ARGUMENT_ORDER = [
  'actorUserId',
  'actorNick',
  'repo',
  'installationId',
  'uploaderVersion',
  'redactionVersion',
  'records'
] as const

export function transportExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TRANSPORT_CLI_PATH?.trim()
  if (configured) return configured
  const defaultPath = join(env.HOME?.trim() || homedir(), '.local', 'bin', 'transport')
  if (executableSync(defaultPath)) return defaultPath
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'transport')
    if (executableSync(candidate)) return candidate
  }
  return defaultPath
}

async function verifyTransportExecutable(path: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!(await executable(path))) return false
  const result = await run(path, ['--no-update-check', 'version'], { env, timeoutMs: 15_000 })
  if (result.exitCode !== 0)
    throw new Error(`transport 安装无效：${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return true
}

export async function ensureTransportInstalled(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch } = {}
): Promise<string> {
  const target = transportExecutable(env)
  if (await verifyTransportExecutable(target, env)) return target

  const installDirectory = dirname(target)
  if (basename(target) !== 'transport') throw new Error(`TRANSPORT_CLI_PATH 必须指向名为 transport 的可执行文件：${target}`)

  const temporary = await mkdtemp(join(tmpdir(), 'scry-uploader-transport-'))
  const scriptPath = join(temporary, 'install.sh')
  try {
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(TRANSPORT_INSTALL_URL, { signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      throw new Error(`下载 transport 安装脚本失败：${error instanceof Error ? error.message : String(error)}`, {
        cause: error
      })
    }
    if (!response.ok) throw new Error(`下载 transport 安装脚本失败：HTTP ${response.status}`)
    const script = await response.text()
    if (Buffer.byteLength(script, 'utf8') > 1024 * 1024)
      throw new Error('下载 transport 安装脚本失败：脚本超过 1 MiB')
    await writeFile(scriptPath, script, { mode: 0o700 })

    const installEnv = {
      ...env,
      TRANSPORT_INSTALL_DIR: installDirectory,
      TRANSPORT_INSTALL_AUX_CLI: '0',
      TRANSPORT_SKIP_OPTIONAL_COMPONENT: '1',
      TRANSPORT_SKIP_PATH: '1'
    }
    const installed = await run('/bin/sh', [scriptPath], {
      cwd: temporary,
      env: installEnv,
      timeoutMs: 180_000
    })
    if (installed.exitCode !== 0) {
      throw new Error(
        `自动安装 transport 失败：${installed.stderr.trim() || installed.stdout.trim() || `exit ${installed.exitCode}`}`
      )
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }

  if (!(await verifyTransportExecutable(target, env))) throw new Error(`transport 安装完成但未找到可执行文件：${target}`)
  env.TRANSPORT_CLI_PATH = target
  return target
}

type TransportFailure = Error & {
  code?: string
  exitCode?: number
  signal?: NodeJS.Signals
  stderr?: string
  stdout?: string
  statusCode?: number
  retryAfterMs?: number
}

function statusFromText(value: string): number | undefined {
  const match = value.match(/(?:status|http|HTTP|code)[^0-9]{0,8}(4\d\d|5\d\d)\b/)
  return match ? Number(match[1]) : undefined
}
function safeDiagnostic(value: string): string {
  return value
    .replace(/(authorization|cookie|token|password|secret|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .slice(0, 512)
}
function retryAfterFromText(value: string): number | undefined {
  const match = value.match(/retry[- ]after\s*[:=]?\s*([^\r\n]+)/i)
  if (!match) return undefined
  const raw = match[1].trim().replace(/[;,]$/, '')
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Date.now() + Math.max(0, seconds * 1_000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? date : undefined
}
function retryAfterValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Date.now() + Math.max(0, value * 1_000)
  if (typeof value === 'string') return retryAfterFromText(`Retry-After: ${value}`)
  return undefined
}

async function runTransport(
  args: string[],
  options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
) {
  let result
  try {
    result = await run(transportExecutable(options.env), ['--no-update-check', ...args], {
      input: options.input,
      timeoutMs: options.timeoutMs ?? 30_000,
      env: options.env
    })
  } catch (error) {
    const source = error as TransportFailure
    if (source.statusCode === 401 || source.statusCode === 403) invalidateAuthCache(options.env ?? process.env)
    const wrapped = new Error(`transport 不可用：${source.message || 'unknown'}`, { cause: error }) as TransportFailure
    Object.assign(wrapped, {
      code: source.code,
      signal: source.signal,
      stderr: source.stderr ? safeDiagnostic(source.stderr) : undefined,
      statusCode: source.statusCode ?? statusFromText(`${source.message ?? ''} ${source.stderr ?? ''}`),
      retryAfterMs: retryAfterFromText(source.stderr ?? '')
    })
    throw wrapped
  }
  if (result.exitCode !== 0) {
    const diagnostic = safeDiagnostic(result.stderr.trim())
    const failure = new Error(`transport 调用失败：${diagnostic || `exit ${result.exitCode}`}`) as TransportFailure
    if (result.stderr.includes('401') || result.stderr.includes('403')) invalidateAuthCache(options.env ?? process.env)
    Object.assign(failure, {
      code: result.signal ? `SIG${result.signal}` : undefined,
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: safeDiagnostic(result.stderr),
      statusCode: statusFromText(result.stderr),
      retryAfterMs: retryAfterFromText(result.stderr)
    })
    throw failure
  }
  return result.stdout
}

export async function actorIdentity(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 15_000
): Promise<Actor> {
  const key = await authCacheKey(env)
  const cached = actorCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  let stdout: string
  try {
    stdout = await runTransport(['auth', 'whoami', '-f', 'json'], { timeoutMs, env })
  } catch (error) {
    invalidateAuthCache(env)
    throw new Error('transport 已安装但未登录；请先执行 transport auth login --sso', { cause: error })
  }
  const raw = JSON.parse(stdout) as unknown
  const value = object(raw)
  if (!value) throw new Error('transport auth whoami 返回格式无效')
  const userId = String(value.subject_id ?? value.account ?? '').trim()
  const nick = String(value.nickname ?? value.name ?? '').trim()
  if (!userId || !nick) throw new Error('transport 登录身份缺少 subject_id 或 nickname')
  const result = { userId: userId.slice(0, 64), nick: nick.slice(0, 64) }
  if (!actorCache.has(key) && actorCache.size >= 8) actorCache.delete(actorCache.keys().next().value!)
  actorCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: result })
  return result
}

export async function toolArgumentStyle(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000
): Promise<ArgumentStyle> {
  const key = await authCacheKey(env)
  const cached = styleCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const raw = JSON.parse(
    await runTransport(['mcp', 'list-tools', MCP_SERVER, '--json'], { timeoutMs, env })
  ) as unknown
  if (!Array.isArray(raw)) throw new Error('transport mcp list-tools 返回格式无效')
  const tool = raw.map(object).find((item) => item?.name === MCP_TOOL)
  if (!tool) throw new Error(`${MCP_SERVER} 未提供 ${MCP_TOOL}`)
  const schema = object(tool.inputSchema)
  const properties = object(schema?.properties)
  if (!properties) throw new Error(`${MCP_TOOL} inputSchema 无效`)
  const keys = new Set(Object.keys(properties))
  let style: ArgumentStyle
  if (ARGUMENT_ORDER.every((key) => keys.has(key))) style = 'named'
  else if (ARGUMENT_ORDER.every((_, index) => keys.has(`fieldName_${index}`))) style = 'field_name'
  else if (ARGUMENT_ORDER.every((_, index) => keys.has(`arg${index}`))) style = 'positional'
  else throw new Error(`${MCP_TOOL} 参数契约不兼容`)
  if (!styleCache.has(key) && styleCache.size >= 8) styleCache.delete(styleCache.keys().next().value!)
  styleCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: style })
  return style
}

export function reportArguments(
  values: Record<string, unknown>,
  style: ArgumentStyle
): Record<string, unknown> {
  if (style === 'named') return values
  if (style === 'field_name') {
    return Object.fromEntries(ARGUMENT_ORDER.map((key, index) => [`fieldName_${index}`, values[key]]))
  }
  return Object.fromEntries(ARGUMENT_ORDER.map((key, index) => [`arg${index}`, values[key]]))
}

export async function callSubmitTurns(
  serializedArguments: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = (TRANSPORT_TIMEOUT_SECONDS + 5) * 1_000
): Promise<unknown> {
  const stdout = await runTransport(
    [
      'mcp',
      'call-tool',
      `${MCP_SERVER}::${MCP_TOOL}`,
      '-',
      '--skill-name',
      MCP_SKILL,
      '--timeout',
      `${Math.min(TRANSPORT_TIMEOUT_SECONDS, Math.max(1, Math.floor(timeoutMs / 1_000)))}s`,
      '-f',
      'json'
    ],
    {
      input: serializedArguments,
      timeoutMs,
      env
    }
  )
  const response = JSON.parse(stdout) as unknown
  const root = object(response)
  if (!root) throw new Error('submitTurns 返回格式无效')
  if (root.success === false) {
    const message = String(root.error ?? root.message ?? 'unknown')
    const failure = new Error(`submitTurns 失败：${message}`) as Error & {
      statusCode?: number
      retryAfterMs?: number
    }
    const status = Number(root.status ?? root.statusCode ?? message.match(/(?:HTTP|status)[^0-9]*(\d{3})/i)?.[1])
    if (Number.isInteger(status)) {
      failure.statusCode = status
      if (status === 401 || status === 403) invalidateAuthCache(env)
    }
    failure.retryAfterMs = retryAfterValue(root.retryAfter ?? root.retry_after)
    throw failure
  }
  return root.success === true && 'data' in root ? root.data : response
}

function boundedRepositoryIdentity(value: string): string {
  return value.length <= 512 ? value : `sha256/${createHash('sha256').update(value).digest('hex')}`
}

function canonicalRemote(value: string): string | undefined {
  const source = value.trim()
  if (!source || /[\r\n]/.test(source)) return undefined
  let host = ''
  let path = ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    let url: URL
    try {
      url = new URL(source)
    } catch {
      return undefined
    }
    // Only repository location is identity: never credentials, query or fragment.
    host = url.host.toLowerCase()
    path = url.pathname
  } else {
    const scp = source.match(/^(?:[^@/]+@)?([^:]+):(.+)$/)
    if (!scp) return undefined
    host = scp[1].toLowerCase()
    path = scp[2]
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!host || !path || path.split('/').some((part) => !part || part === '.' || part === '..')) return undefined
  return boundedRepositoryIdentity(`${host}/${path}`)
}

export async function repositoryName(workspace: string, timeoutMs = 5_000): Promise<string> {
  const remote = await run('git', ['-C', workspace, 'remote', 'get-url', 'origin'], { timeoutMs })
  if (remote.exitCode === 0) {
    const canonical = canonicalRemote(remote.stdout)
    if (canonical) return canonical
  }
  // A non-Git workspace still needs a stable, workspace-specific identity. Do
  // not collapse unrelated workspaces to a common basename.
  return boundedRepositoryIdentity(`workspace:${workspace}`)
}
