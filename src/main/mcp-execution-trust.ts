import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { scanMcp, type ScanReport } from '../cli/mcpguard-core'
import { resolveCommandOnPath } from './claude-locate'
import {
  minimalMcpEnv,
  proxyEnvValueContainsCredentials,
  resolveMcpConfigs,
  type ResolvedMcpConfig
} from './mcp-config'

export type McpExecutionOperation = 'run' | 'live' | `test:${string}`

export interface McpExecutionSnapshot {
  cwd: string
  fingerprint: string
  settingSources: string
  executionEnv: NodeJS.ProcessEnv
  targets: ResolvedMcpConfig[]
  report: ScanReport
  errors: string[]
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`
}

const EXECUTION_SHAPING_ENV = new Set([
  'PATH', 'Path', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME',
  'RUBYOPT', 'PERL5OPT', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'DOTNET_STARTUP_HOOKS', 'LUA_INIT'
])

const ENV_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g

function interpolationReferences(value: unknown, path: string, result: string[]): void {
  if (typeof value === 'string') {
    const names = [...value.matchAll(ENV_INTERPOLATION)].map((match) => match[1])
    if (names.length > 0) result.push(`${path}: ${[...new Set(names)].join(', ')}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => interpolationReferences(item, `${path}[${index}]`, result))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    interpolationReferences(item, `${path}.${key}`, result)
  }
}

function normalizedExecutionTarget(
  target: ResolvedMcpConfig,
  cwd: string,
  inheritedEnv: NodeJS.ProcessEnv,
  errors: string[],
  executable: boolean
): ResolvedMcpConfig {
  const config = { ...target.config }
  if (!executable) return { ...target, config }
  const interpolations: string[] = []
  for (const key of ['command', 'args', 'env', 'url', 'headers'] as const) {
    interpolationReferences(config[key], key, interpolations)
  }
  if (interpolations.length > 0) {
    errors.push(
      `MCP server ${target.name} 使用不受支持的父进程环境插值（${interpolations.join('；')}）；请把值显式放入已审查的 config.env/headers 或安全存储`
    )
  }
  const configuredEnv = config.env && typeof config.env === 'object'
    ? config.env as Record<string, unknown>
    : {}
  const dangerousKeys = Object.keys(configuredEnv).filter((key) =>
    EXECUTION_SHAPING_ENV.has(key) || key.startsWith('DYLD_') || key.startsWith('LD_')
  )
  if (dangerousKeys.length > 0) {
    errors.push(`MCP server ${target.name} 使用可改变执行目标的 env：${dangerousKeys.join(', ')}`)
  }
  if (typeof config.command === 'string' && config.command.trim()) {
    const command = config.command.trim()
    const absolute = isAbsolute(command)
      ? command
      : command.includes('/') || command.includes('\\')
        ? resolve(cwd, command)
        : resolveCommandOnPath(command, inheritedEnv.PATH ?? '')
    if (!absolute) {
      errors.push(`MCP server ${target.name} 的 executable 无法在登录 shell PATH 中解析：${command}`)
    } else {
      try {
        const canonical = realpathSync(absolute)
        const stat = statSync(canonical)
        if (!stat.isFile()) throw new Error('not a regular file')
        if (process.platform !== 'win32') accessSync(canonical, constants.X_OK)
        config.command = canonical
        return {
          ...target,
          config,
          executableIdentity: `${canonical}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
        }
      } catch {
        errors.push(`MCP server ${target.name} 的 executable 不是可信可执行文件：${absolute}`)
      }
    }
  }
  return { ...target, config }
}

export function buildMcpExecutionSnapshot(args: {
  cwd?: string
  homeDir: string
  settingSources?: string
  env?: NodeJS.ProcessEnv
  selectedTargetId?: string
}): McpExecutionSnapshot {
  const errors: string[] = []
  const requestedCwd = args.cwd ?? process.cwd()
  let cwd = resolve(requestedCwd)
  try {
    cwd = realpathSync(cwd)
  } catch {
    errors.push(`MCP 工作目录不存在或不可解析：${requestedCwd}`)
  }
  const executionEnv = {
    ...minimalMcpEnv(args.env),
    CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1'
  }
  const targets = resolveMcpConfigs(args.cwd, args.homeDir).map((target) =>
    normalizedExecutionTarget(
      target,
      cwd,
      executionEnv,
      errors,
      target.enabled || target.targetId === args.selectedTargetId
    )
  )
  const credentialProxyKeys = Object.entries(args.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .filter(([key, value]) => proxyEnvValueContainsCredentials(key, value))
    .map(([key]) => key)
  const enabledRemoteTargets = targets.filter((target) => target.enabled && target.transport === 'http')
  if (credentialProxyKeys.length > 0 && enabledRemoteTargets.length > 0) {
    errors.push(
      `启用的远程 MCP（${enabledRemoteTargets.map((target) => target.name).join(', ')}）无法与含凭据代理环境隔离：${credentialProxyKeys.join(', ')}`
    )
  }
  const configPaths = [
    join(args.homeDir, '.claude.json'),
    ...(args.cwd ? [join(args.cwd, '.mcp.json'), join(args.cwd, '.claude', 'settings.local.json')] : [])
  ].filter((path) => existsSync(path))
  const report = scanMcp({ cwd, home: args.homeDir, configPaths })
  const reportIds = new Set(report.targets.map((target) => target.targetId))
  errors.push(...report.errors)
  for (const target of targets) {
    if (!reportIds.has(target.targetId)) errors.push(`MCP Guard 未识别配置目标 ${target.targetId}`)
  }
  const enabledNames = new Map<string, string[]>()
  for (const target of targets.filter((item) => item.enabled)) {
    const ids = enabledNames.get(target.name) ?? []
    ids.push(target.targetId)
    enabledNames.set(target.name, ids)
  }
  for (const [name, ids] of enabledNames) {
    if (ids.length > 1) errors.push(`MCP server ${name} 存在 ${ids.length} 个启用定义，执行优先级不唯一`)
  }
  const settingSources = args.settingSources?.trim() || 'default:user,project,local'
  const canonical = {
    cwd,
    settingSources,
    executionEnv,
    targets: targets.map((target) => ({
      targetId: target.targetId,
      sourcePath: target.sourcePath,
      jsonPointer: target.jsonPointer,
      enabled: target.enabled,
      config: target.config,
      executableIdentity: target.executableIdentity
    }))
  }
  return {
    cwd,
    settingSources,
    executionEnv,
    targets,
    report,
    errors,
    fingerprint: `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`
  }
}

export class McpExecutionTrust {
  private readonly grants = new Set<string>()

  isGranted(operation: McpExecutionOperation, snapshot: McpExecutionSnapshot): boolean {
    return this.grants.has(`${operation}\0${snapshot.cwd}\0${snapshot.fingerprint}`)
  }

  grant(operation: McpExecutionOperation, snapshot: McpExecutionSnapshot): void {
    this.grants.add(`${operation}\0${snapshot.cwd}\0${snapshot.fingerprint}`)
  }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function summarizedUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = 'redacted'
      url.password = 'redacted'
    }
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '<redacted>')
    url.hash = ''
    return url.toString()
  } catch {
    return `<url sha256:${shortHash(value)}>`
  }
}

function summarizedArgs(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return ''
  return value.map((item) => {
    const raw = String(item)
    if (/^--?[A-Za-z0-9][A-Za-z0-9_-]*(?:=.*)?$/.test(raw)) return raw.replace(/=.*/, '=<redacted>')
    return `<arg sha256:${shortHash(raw)}>`
  }).join(' ')
}

export function mcpTargetSummary(target: ResolvedMcpConfig, inheritedEnv: NodeJS.ProcessEnv = {}): string {
  const config = target.config
  const args = summarizedArgs(config.args)
  const command = [String(config.command ?? ''), args].filter(Boolean).join(' ')
  const destination = typeof config.url === 'string'
    ? summarizedUrl(config.url)
    : command || '(未指定启动目标)'
  const envEntries = config.env && typeof config.env === 'object'
    ? Object.entries(config.env as Record<string, unknown>).map(([key, value]) => {
        const raw = String(value ?? '')
        const secret = /(token|secret|password|credential|cookie|api[_-]?key|authorization)/i.test(key)
          || proxyEnvValueContainsCredentials(key, raw)
        const shown = secret
          ? `<redacted sha256:${shortHash(raw)}>`
          : JSON.stringify(raw.slice(0, 240))
        return `${key}=${shown}`
      })
    : []
  const headerKeys = config.headers && typeof config.headers === 'object'
    ? Object.keys(config.headers as Record<string, unknown>)
    : []
  return [
    `${target.name} · ${target.scope}`,
    `  target: ${target.targetId}`,
    `  source: ${target.sourcePath}${target.jsonPointer}`,
    `  execute: ${destination}`,
    `  configured env: ${envEntries.length ? envEntries.join(', ') : '(none)'}`,
    `  inherited env keys: ${Object.keys(inheritedEnv).sort().join(', ') || '(none)'}`,
    `  header keys: ${headerKeys.length ? headerKeys.join(', ') : '(none)'}`
  ].join('\n')
}
