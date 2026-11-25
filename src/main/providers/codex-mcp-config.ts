import { randomBytes } from 'node:crypto'
import { HISTORY_READER_SERVER, HISTORY_READER_TOOL, type HistoryReaderConnection } from '../conversation-history-reader'
import { authorizedMcpServers, isRemoteMcpConfig } from '../mcp-config'
import { codexStdioEnvFile, codexStdioLauncher, codexStdioLauncherEnv } from './codex-stdio-env'
import { writePrivateMcpEnvFiles } from './private-mcp-config'
import { record } from './codex-trace'
import type { McpSnapshot } from '../../shared/provider'
import type { ResolvedMcpConfig } from '../mcp-config'
import type { CodexMcpConfig } from './codex-mcp-config-types'
import type { AuthorizedMcpExecution } from './types'

export function tomlInline(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(tomlInline).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && item !== null)
      .map(([key, item]) => `${JSON.stringify(key)}=${tomlInline(item)}`)
      .join(',')}}`
  }
  throw new Error('Codex MCP 配置包含不支持的 TOML 值')
}


/**
 * Static remote `headers` would sit on the app-server argv (`-c mcp_servers=...`),
 * which every local user can read through `ps`. Each one instead goes into the
 * Codex process env under a per-client random name that `env_http_headers` names,
 * the same indirection the history-reader token uses (`bearer_token_env_var`).
 * Kept inline, so Codex behaves exactly as before: empty, whitespace-padded or
 * non-string values (Codex skips an empty env header and may trim one), and a
 * header the config's own `env_http_headers` also sets, compared case-insensitively
 * (Codex applies that override after static headers; one map would make the winner
 * arbitrary). Stdio `env` goes to a private file that a fixed /bin/sh launcher reads
 * before exec'ing the original command (codex-stdio-env.ts); `env_vars` would forward
 * a parent variable only under its own name, so per-server values could collide.
 */
export function codexMcpConfig(
  execution?: AuthorizedMcpExecution,
  historyReader?: HistoryReaderConnection,
  nonce = randomBytes(6).toString('hex').toUpperCase()
): CodexMcpConfig {
  const servers: Record<string, Record<string, unknown>> = {}
  const env: Record<string, string> = {}
  const launched: Array<{ name: string; env: Record<string, string> }> = []
  for (const [name, config] of Object.entries(authorizedMcpServers(execution))) {
    if (!isRemoteMcpConfig(config)) {
      const launcherEnv = codexStdioLauncherEnv(config)
      if (launcherEnv) launched.push({ name, env: launcherEnv })
      servers[name] = {
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        enabled: true,
        startup_timeout_sec: config.startup_timeout_sec,
        tool_timeout_sec: config.tool_timeout_sec
      }
      continue
    }
    const configuredEnvHeaders = config.env_http_headers && typeof config.env_http_headers === 'object'
      ? config.env_http_headers as Record<string, unknown>
      : undefined
    const overridden = new Set(Object.keys(configuredEnvHeaders ?? {}).map((header) => header.toLowerCase()))
    const inline: Record<string, unknown> = {}
    const fromEnv: Record<string, string> = {}
    for (const [header, value] of Object.entries(record(config.headers))) {
      if (typeof value === 'string' && value !== '' && value === value.trim() && !overridden.has(header.toLowerCase())) {
        const variable = `SCRY_MCP_HEADER_${nonce}_${Object.keys(env).length}`
        env[variable] = value
        fromEnv[header] = variable
      } else {
        inline[header] = value
      }
    }
    const envHeaders = { ...configuredEnvHeaders, ...fromEnv }
    servers[name] = {
      url: config.url,
      http_headers: Object.keys(inline).length > 0 ? inline : undefined,
      bearer_token_env_var: config.bearer_token_env_var,
      env_http_headers: Object.keys(envHeaders).length > 0 ? envHeaders : undefined,
      enabled: true,
      startup_timeout_sec: config.startup_timeout_sec,
      tool_timeout_sec: config.tool_timeout_sec
    }
  }
  if (historyReader) {
    if (servers[HISTORY_READER_SERVER]) throw new Error('仓库 MCP 名称与 App 历史检索服务冲突')
    servers[HISTORY_READER_SERVER] = { url: historyReader.url, bearer_token_env_var: 'SCRY_HISTORY_READER_TOKEN',
      enabled: true, enabled_tools: [HISTORY_READER_TOOL], startup_timeout_sec: 10, tool_timeout_sec: 10 }
  }
  const files = writePrivateMcpEnvFiles(launched.map((item) => codexStdioEnvFile(item.env)))
  try {
    launched.forEach((item, index) => { servers[item.name] = codexStdioLauncher(servers[item.name], files!.paths[index]) })
    return { args: ['-c', `mcp_servers=${tomlInline(servers)}`], env, ...(files ? { dispose: files.dispose } : {}) }
  } catch (error) {
    files?.dispose()
    throw error
  }
}

export function codexMcpOAuthBlockReason(config: Record<string, unknown>): string | undefined {
  if (!isRemoteMcpConfig(config)) return 'stdio MCP 不支持 OAuth 重新认证'
  if (config.headers && typeof config.headers === 'object' && Object.keys(config.headers).length > 0) {
    return 'Codex 浏览器 OAuth 不会把静态 http_headers 传入认证子进程；请移除静态 Header 后使用 Provider 原生 OAuth'
  }
  if (
    (config.env_http_headers && typeof config.env_http_headers === 'object'
      && Object.keys(config.env_http_headers).length > 0)
    || config.bearer_token_env_var !== undefined
  ) {
    return 'Codex 浏览器 OAuth 不会把凭据环境变量传入认证子进程；请移除 env_http_headers / bearer_token_env_var 后使用 Provider 原生 OAuth'
  }
  return undefined
}


export const codexMcpOperations = (configured: ResolvedMcpConfig[]): NonNullable<McpSnapshot['operations']> => {
  const nameCounts = new Map<string, number>()
  for (const item of configured) {
    if (item.enabled) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1)
  }
  return {
    authenticate: configured.flatMap((item) =>
      item.enabled && nameCounts.get(item.name) === 1 && !codexMcpOAuthBlockReason(item.config) && item.targetId
        ? [item.targetId]
        : []
    )
  }
}

