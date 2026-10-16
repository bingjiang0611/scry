import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProviderContext } from '../../shared/provider'

export class ContinuationIdentityUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContinuationIdentityUnavailable'
  }
}

type RuntimeEnv = Readonly<Record<string, string | undefined>>

function requiredFile(path: string, label: string): string {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
    throw new ContinuationIdentityUnavailable(`${label} 不可读取`)
  }
  if (!stat.isFile()) throw new ContinuationIdentityUnavailable(`${label} 不是普通文件`)
  if ((stat.mode & 0o111) === 0 && label === 'Provider executable') {
    throw new ContinuationIdentityUnavailable('Provider executable 不可执行')
  }
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    throw new ContinuationIdentityUnavailable(`${label} 不可读取`)
  }
}

function executableIdentity(path: string | undefined): string {
  if (!path) throw new ContinuationIdentityUnavailable('Provider executable 不可用')
  let canonical: string
  try { canonical = realpathSync(path) } catch { throw new ContinuationIdentityUnavailable('Provider executable 路径不可解析') }
  let stat
  try { stat = statSync(canonical) } catch { throw new ContinuationIdentityUnavailable('Provider executable 不可读取') }
  const bytes = requiredFile(canonical, 'Provider executable')
  return `${canonical}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${bytes}`
}

function directoryIdentity(path: string, label: string): string {
  if (!path) throw new ContinuationIdentityUnavailable(`${label} 不可用`)
  try {
    const canonical = realpathSync(path)
    if (!statSync(canonical).isDirectory()) throw new Error('not directory')
    return canonical
  } catch {
    throw new ContinuationIdentityUnavailable(`${label} 不可解析`)
  }
}

function optionalConfigPath(home: string, configRoot: string, customRoot: boolean): string | undefined {
  const candidates = [
    join(configRoot, '.config.json'),
    join(customRoot ? configRoot : home, '.claude.json')
  ]
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate)
      if (!stat.isFile()) throw new ContinuationIdentityUnavailable('Claude legacy config 不是普通文件')
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (error instanceof ContinuationIdentityUnavailable) throw error
      throw new ContinuationIdentityUnavailable('Claude legacy config 不可读取')
    }
  }
  return undefined
}

function readJsonObject(path: string, label: string): Record<string, unknown> | undefined {
  try {
    if (!statSync(path).isFile()) throw new ContinuationIdentityUnavailable(`${label} 不是普通文件`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof ContinuationIdentityUnavailable) throw error
    throw new ContinuationIdentityUnavailable(`${label} 不可读取`)
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ContinuationIdentityUnavailable(`${label} 状态无效`)
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof ContinuationIdentityUnavailable) throw error
    throw new ContinuationIdentityUnavailable(`${label} 状态不可读取`)
  }
}

const AUTH_SETTING_NAMES = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'AWS_BEARER_TOKEN_BEDROCK', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY',
  'GOOGLE_CLOUD_PROJECT', 'VERTEXAI_PROJECT', 'VERTEXAI_LOCATION'
])

function authSettings(
  context: ProviderContext,
  configRoot: string,
  runtimeEnv: RuntimeEnv
): string[] {
  const paths = [
    join(configRoot, 'settings.json'),
    ...(context.cwd ? [join(context.cwd, '.claude', 'settings.json'), join(context.cwd, '.claude', 'settings.local.json')] : [])
  ]
  const material: string[] = []
  for (const path of paths) {
    const settings = readJsonObject(path, 'Claude settings')
    if (!settings) continue
    for (const helper of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']) {
      if (Object.prototype.hasOwnProperty.call(settings, helper)) {
        throw new ContinuationIdentityUnavailable(`Claude 使用未验证的动态认证 helper：${helper}`)
      }
    }
    const loginMethod = settings.forceLoginMethod
    if (loginMethod === 'bedrock' || loginMethod === 'vertex' || loginMethod === 'foundry') {
      throw new ContinuationIdentityUnavailable(`Claude 云凭据模式 ${loginMethod} 尚未建立可验证身份`)
    }
    const env = settings.env
    if (env !== undefined) {
      if (!env || typeof env !== 'object' || Array.isArray(env)) {
        throw new ContinuationIdentityUnavailable('Claude settings.env 状态无效')
      }
      for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
        if (!AUTH_SETTING_NAMES.has(name)) continue
        if (typeof value !== 'string') throw new ContinuationIdentityUnavailable(`Claude settings ${name} 不是静态字符串`)
        if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].includes(name) &&
          !['0', 'false', 'off'].includes(value.toLowerCase())) {
          throw new ContinuationIdentityUnavailable(`Claude 云凭据模式 ${name} 尚未建立可验证身份`)
        }
        material.push(`setting-env:${path}:${name}\0${createHash('sha256').update(value, 'utf8').digest('hex')}`)
      }
    }
    for (const name of ['apiKey', 'authToken', 'baseUrl', 'apiUrl', 'apiEndpoint', 'forceLoginMethod', 'forceLoginOrgUUID']) {
      if (Object.prototype.hasOwnProperty.call(settings, name)) {
        const value = settings[name]
        if (typeof value !== 'string') throw new ContinuationIdentityUnavailable(`Claude settings ${name} 不是静态字符串`)
        material.push(`setting:${path}:${name}\0${createHash('sha256').update(value, 'utf8').digest('hex')}`)
      }
    }
  }
  for (const name of AUTH_SETTING_NAMES) {
    const value = runtimeEnv[name]
    if (value && ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].includes(name) &&
      !['0', 'false', 'off'].includes(value.toLowerCase())) {
      throw new ContinuationIdentityUnavailable(`Claude 云凭据模式 ${name} 尚未建立可验证身份`)
    }
  }
  return material.sort()
}

function intendedNamespace(path: string, label: string, nativeSymlinks = false): string {
  const candidate = resolve(path)
  const inspect = nativeSymlinks ? statSync : lstatSync
  try {
    const stat = inspect(candidate)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ContinuationIdentityUnavailable(`${label} 不是本地目录`)
    return realpathSync(candidate)
  } catch (error) {
    if (error instanceof ContinuationIdentityUnavailable) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ContinuationIdentityUnavailable(`${label} 不可解析`)
    }
  }
  let parent = candidate
  const suffix: string[] = []
  while (true) {
    try {
      const stat = inspect(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ContinuationIdentityUnavailable(`${label} 的父目录不可解析`)
      }
      return join(realpathSync(parent), ...suffix.reverse())
    } catch (error) {
      if (error instanceof ContinuationIdentityUnavailable) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ContinuationIdentityUnavailable(`${label} 的父目录不可解析`)
      }
      const next = join(parent, '..')
      suffix.push(parent.slice(parent.lastIndexOf(sep) + 1))
      if (next === parent) throw new ContinuationIdentityUnavailable(`${label} 不可解析`)
      parent = next
    }
  }
}

function containsPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function parseClaudeAuthority(path: string): { accountUuid: string; organizationUuid?: string } | undefined {
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch {
    throw new ContinuationIdentityUnavailable('Claude auth/config 状态不可读取')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContinuationIdentityUnavailable('Claude auth/config 状态无效')
  }
  const oauth = (value as { oauthAccount?: unknown }).oauthAccount
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return undefined
  const accountUuid = (oauth as { accountUuid?: unknown }).accountUuid
  const organizationUuid = (oauth as { organizationUuid?: unknown }).organizationUuid
  if (typeof accountUuid !== 'string' || accountUuid.length === 0) return undefined
  return {
    accountUuid,
    ...(typeof organizationUuid === 'string' && organizationUuid.length > 0 ? { organizationUuid } : {})
  }
}

function secretIdentity(env: RuntimeEnv, names: readonly string[]): string[] {
  return names.map((name) => {
    const value = env[name]
    return `${name}\0${value === undefined ? 'unset' : createHash('sha256').update(value, 'utf8').digest('hex')}`
  })
}

function digest(material: readonly string[]): string {
  return createHash('sha256').update(material.join('\n'), 'utf8').digest('hex')
}

export function claudeContinuationKey(
  context: ProviderContext,
  homeDir: string,
  executable: string | undefined,
  runtimeEnv: RuntimeEnv = process.env
): string {
  const nativeCwd = context.cwd ?? process.cwd()
  const home = directoryIdentity(resolve(nativeCwd, homeDir), 'Claude home')
  const configuredRoot = runtimeEnv.CLAUDE_CONFIG_DIR
  const configRoot = configuredRoot
    ? intendedNamespace(resolve(nativeCwd, configuredRoot), 'Claude config root', true)
    : intendedNamespace(join(home, '.claude'), 'Claude config root', true)
  const configPath = optionalConfigPath(home, configRoot, !!configuredRoot)
  const authority = configPath ? parseClaudeAuthority(configPath) : undefined
  const oauthToken = runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = runtimeEnv.ANTHROPIC_API_KEY
  const cloudMode = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
  if (cloudMode.some((name) => runtimeEnv[name] && !['0', 'false', 'off'].includes(runtimeEnv[name]!.toLowerCase()))) {
    throw new ContinuationIdentityUnavailable('Claude 云凭据模式尚未建立可验证身份')
  }
  const settings = authSettings(context, configRoot, runtimeEnv)
  if (!authority && !oauthToken && !apiKey) {
    throw new ContinuationIdentityUnavailable('Claude 缺少可验证的 OAuth account 或 API key 身份')
  }
  const auth = authority
    ? [`oauth-account\0${authority.accountUuid}`, `oauth-org\0${authority.organizationUuid ?? 'unset'}`]
    : []
  return `claude:${digest([
    'scry-continuation-v2', 'claude', context.cwd ?? '', context.agentProfileId ?? '',
    executableIdentity(executable), home, configRoot, configPath ?? 'no-config',
    ...auth, ...settings,
    ...secretIdentity(runtimeEnv, ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'SCRY_CLAUDE_SETTING_SOURCES',
      'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'VERTEXAI_PROJECT', 'VERTEXAI_LOCATION'])
  ])}`
}

export function codexContinuationKey(
  context: ProviderContext,
  sourceHome: string | undefined,
  isolatedHome: string,
  executable: string | undefined,
  runtimeEnv: RuntimeEnv,
  authState: 'planned' | 'materialized'
): string {
  const configuredSource = sourceHome ?? runtimeEnv.CODEX_HOME ??
    (runtimeEnv.HOME ? join(runtimeEnv.HOME, '.codex') : undefined)
  if (!configuredSource) throw new ContinuationIdentityUnavailable('Codex runtime HOME 不可用')
  const source = directoryIdentity(configuredSource, 'Codex source home')
  const privateHome = intendedNamespace(isolatedHome, 'Codex isolated home')
  if (containsPath(source, privateHome) || containsPath(privateHome, source)) {
    throw new ContinuationIdentityUnavailable('Codex isolated home 与 source home 不能重叠')
  }
  // Before materialization, the existing helper will link source auth into the
  // intended namespace. Afterwards only the actual transport home is authority:
  // a missing private auth file must not silently inherit a source credential.
  const authPath = join(authState === 'materialized' ? privateHome : source, 'auth.json')
  let authHash: string | undefined
  try {
    authHash = requiredFile(authPath, 'Codex effective auth state')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const apiKey = runtimeEnv.OPENAI_API_KEY ?? runtimeEnv.CODEX_API_KEY
  if (!authHash && !apiKey) throw new ContinuationIdentityUnavailable('Codex 缺少可验证的 auth.json 或 API key 身份')
  return `codex:${digest([
    'scry-continuation-v2', 'codex', context.cwd ?? '', context.agentProfileId ?? '',
    executableIdentity(executable), source, privateHome, authHash ?? 'env-key',
    ...secretIdentity(runtimeEnv, ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_AUTH_MODE', 'OPENAI_BASE_URL'])
  ])}`
}
