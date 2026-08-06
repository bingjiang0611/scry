import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { mcpConfigTargetId, parseTomlDocument } from '../cli/mcpguard-core'
import type { ProviderId } from '../shared/provider'
import type { AuthorizedMcpExecution } from './providers/types'

export interface McpConfigItem {
  targetId: string
  name: string
  scope: string
  transport: string
  detail: string
  enabled: boolean
}

export interface ResolvedMcpConfig extends McpConfigItem {
  sourcePath: string
  jsonPointer: string
  config: Record<string, unknown>
  executableIdentity?: string
}

export interface McpTestResult {
  ok: boolean
  tools?: number
  toolNames?: string[]
  error?: string
}

const MCP_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
  'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
])

function managedMcpEnvKey(key: string): boolean {
  return MCP_ENV_KEYS.has(key) || key.startsWith('LC_') || /^(?:https?|all|no)_proxy$/i.test(key)
}

export function proxyEnvValueContainsCredentials(key: string, value: string): boolean {
  if (!/^(?:https?|all)_proxy$/i.test(key)) return false
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password) return true
  } catch {
    // Proxy variables are sometimes written without a scheme. Inspect only the
    // authority-shaped prefix so an @ in a later path cannot cause a false hit.
  }
  const authority = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/, 1)[0]
  return authority.includes('@')
}

export function minimalMcpEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) =>
      value !== undefined
      && (MCP_ENV_KEYS.has(key) || key.startsWith('LC_'))
      && !proxyEnvValueContainsCredentials(key, value)
    )
  )
}

export function authorizedMcpRuntimeEnv(
  source: Record<string, string>,
  authorized: NodeJS.ProcessEnv
): Record<string, string> {
  const out = Object.fromEntries(
    Object.entries(source).filter(([key]) => !managedMcpEnvKey(key) && key !== 'CLAUDE_CODE_MCP_ALLOWLIST_ENV')
  )
  for (const [key, value] of Object.entries(authorized)) {
    if (value !== undefined) out[key] = value
  }
  out.CLAUDE_CODE_MCP_ALLOWLIST_ENV = '1'
  return out
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readToml(file: string): Record<string, unknown> | null {
  try {
    return parseTomlDocument(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function absoluteConfigRoot(value: string | undefined, fallback: string, cwd: string | undefined): string {
  const configured = value?.trim()
  if (!configured) return fallback
  return isAbsolute(configured) ? configured : resolve(cwd ?? fallback, configured)
}

export function providerMcpConfigPaths(
  providerId: ProviderId,
  cwd: string | undefined,
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (providerId === 'claude') {
    return [
      join(homeDir, '.claude.json'),
      ...(cwd ? [join(cwd, '.mcp.json'), join(cwd, '.claude', 'settings.local.json')] : [])
    ]
  }
  if (providerId === 'codex') {
    const codexHome = absoluteConfigRoot(env.CODEX_HOME, join(homeDir, '.codex'), cwd)
    return [join(codexHome, 'config.toml'), ...(cwd ? [join(cwd, '.codex', 'config.toml')] : [])]
  }
  if (providerId === 'qoder') {
    const qoderRoot = env.QODER_CONFIG_DIR?.trim()
      ? absoluteConfigRoot(env.QODER_CONFIG_DIR, join(homeDir, '.qoder'), cwd)
      : join(absoluteConfigRoot(env.QODER_CLI_HOME, homeDir, cwd), '.qoder')
    return [join(qoderRoot, 'mcp.json'), ...(cwd ? [join(cwd, '.mcp.json'), join(cwd, '.qoder', 'mcp.json')] : [])]
  }
  const configured = env.OPENCODE_CONFIG?.trim()
  const configHome = absoluteConfigRoot(env.XDG_CONFIG_HOME, join(homeDir, '.config'), cwd)
  return [
    configured ? absoluteConfigRoot(configured, join(configHome, 'opencode', 'opencode.json'), cwd) : join(configHome, 'opencode', 'opencode.json'),
    ...(cwd ? [join(cwd, 'opencode.json')] : [])
  ]
}

function normalizedProviderConfig(providerId: ProviderId, value: unknown): Record<string, unknown> {
  const raw = record(value)
  if (providerId !== 'opencode') {
    const headers = raw.headers ?? raw.http_headers
    return headers === raw.headers ? { ...raw } : { ...raw, headers }
  }
  const command = Array.isArray(raw.command) ? raw.command.filter((item): item is string => typeof item === 'string') : []
  if (raw.type === 'local' || command.length > 0) {
    return {
      ...raw,
      type: 'stdio',
      command: command[0] ?? raw.command,
      args: command.slice(1),
      env: record(raw.environment ?? raw.env)
    }
  }
  return { ...raw, type: raw.type === 'remote' ? 'http' : raw.type }
}

export function resolveProviderMcpConfigs(
  providerId: ProviderId,
  cwd: string | undefined,
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedMcpConfig[] {
  if (providerId === 'claude') return resolveClaudeMcpConfigs(cwd, homeDir)
  const result: ResolvedMcpConfig[] = []
  const workspaceRoot = cwd ?? process.cwd()
  const paths = providerMcpConfigPaths(providerId, cwd, homeDir, env)
  const addGroup = (
    servers: Record<string, unknown>,
    scope: string,
    sourcePath: string,
    pointer: string
  ): void => {
    for (const [name, value] of Object.entries(servers)) {
      const native = record(value)
      const config = normalizedProviderConfig(providerId, native)
      const jsonPointer = `${pointer}/${escapeJsonPointer(name)}`
      const remote = Boolean(config.url) || config.type === 'http' || config.type === 'sse'
      result.push({
        targetId: mcpConfigTargetId(name, sourcePath, jsonPointer, workspaceRoot, homeDir),
        name,
        scope,
        transport: remote ? 'http' : 'stdio',
        detail: String(config.url ?? config.command ?? ''),
        enabled: native.enabled !== false && native.disabled !== true,
        sourcePath,
        jsonPointer,
        config
      })
    }
  }
  for (const sourcePath of paths) {
    if (!existsSync(sourcePath)) continue
    const parsed = sourcePath.endsWith('.toml') ? readToml(sourcePath) : readJson(sourcePath)
    if (!parsed) continue
    const scope = cwd && sourcePath.startsWith(`${cwd}/`) ? 'project' : 'user'
    if (providerId === 'codex') addGroup(record(parsed.mcp_servers), scope, sourcePath, '/mcp_servers')
    if (providerId === 'qoder') addGroup(record(parsed.mcpServers), scope, sourcePath, '/mcpServers')
    if (providerId === 'opencode') addGroup(record(parsed.mcp), scope, sourcePath, '/mcp')
  }
  return result
}

export function mcpDisabledSet(cwd: string | undefined, homeDir: string): Set<string> {
  if (!cwd) return new Set()
  const disabledJson = new Set<string>()
  const disabledUser = new Set<string>()
  const enabledJson = new Set<string>()
  const add = (set: Set<string>, a: unknown): void => {
    if (Array.isArray(a)) for (const n of a) set.add(String(n))
  }
  const claudeJson = readJson(join(homeDir, '.claude.json'))
  const project = (claudeJson?.projects as Record<string, Record<string, unknown>> | undefined)?.[cwd]
  add(disabledJson, project?.disabledMcpjsonServers)
  add(disabledUser, project?.disabledMcpServers)
  add(enabledJson, project?.enabledMcpjsonServers)

  const localSettings = readJson(join(cwd, '.claude', 'settings.local.json'))
  add(disabledJson, localSettings?.disabledMcpjsonServers)
  add(disabledUser, localSettings?.disabledMcpServers)
  add(enabledJson, localSettings?.enabledMcpjsonServers)

  for (const n of enabledJson) disabledJson.delete(n)
  return new Set([...disabledJson, ...disabledUser])
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function resolveClaudeMcpConfigs(cwd: string | undefined, homeDir: string): ResolvedMcpConfig[] {
  const disabled = mcpDisabledSet(cwd, homeDir)
  const result: ResolvedMcpConfig[] = []
  const workspaceRoot = cwd ?? process.cwd()
  const add = (
    name: string,
    cfg: Record<string, unknown>,
    scope: string,
    sourcePath: string,
    jsonPointer: string
  ): void => {
    const transport = cfg?.url || cfg?.type === 'http' || cfg?.type === 'sse' ? 'http' : 'stdio'
    result.push({
      targetId: mcpConfigTargetId(name, sourcePath, jsonPointer, workspaceRoot, homeDir),
      name,
      scope,
      transport,
      detail: String(cfg?.url || cfg?.command || ''),
      enabled: !disabled.has(name),
      sourcePath,
      jsonPointer,
      config: cfg
    })
  }

  const claudePath = join(homeDir, '.claude.json')
  const claudeJson = readJson(claudePath)
  for (const [n, c] of Object.entries((claudeJson?.mcpServers as Record<string, unknown> | undefined) || {})) {
    add(n, c as Record<string, unknown>, 'user', claudePath, `/mcpServers/${escapeJsonPointer(n)}`)
  }
  const projectServers = cwd
    ? (claudeJson?.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined)?.[cwd]?.mcpServers
    : undefined
  if (projectServers) {
    for (const [n, c] of Object.entries(projectServers)) {
      add(
        n,
        c as Record<string, unknown>,
        'project',
        claudePath,
        `/projects/${escapeJsonPointer(cwd ?? '')}/mcpServers/${escapeJsonPointer(n)}`
      )
    }
  }

  const projectMcpPath = cwd ? join(cwd, '.mcp.json') : ''
  const projectMcp = cwd ? readJson(projectMcpPath) : null
  for (const [n, c] of Object.entries((projectMcp?.mcpServers as Record<string, unknown> | undefined) || {})) {
    add(n, c as Record<string, unknown>, '.mcp.json', projectMcpPath, `/mcpServers/${escapeJsonPointer(n)}`)
  }
  return result
}

export function resolveMcpConfigs(cwd: string | undefined, homeDir: string): ResolvedMcpConfig[] {
  return resolveProviderMcpConfigs('claude', cwd, homeDir)
}

export function listProviderMcp(
  providerId: ProviderId,
  cwd: string | undefined,
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): McpConfigItem[] {
  return resolveProviderMcpConfigs(providerId, cwd, homeDir, env)
    .map(({ sourcePath: _sourcePath, jsonPointer: _jsonPointer, config: _config, ...item }) => item)
}

export function listMcp(cwd: string | undefined, homeDir: string): McpConfigItem[] {
  return listProviderMcp('claude', cwd, homeDir)
}

export function isRemoteMcpConfig(config: Record<string, unknown>): boolean {
  return Boolean(config.url) || config.type === 'http' || config.type === 'sse'
}

export function authorizedMcpServers(
  execution: AuthorizedMcpExecution | undefined
): Record<string, Record<string, unknown>> {
  if (!execution) return {}
  return Object.fromEntries(
    execution.targets
      .filter((target) => target.enabled)
      .map((target) => {
        const config = { ...target.config }
        if (!isRemoteMcpConfig(config)) {
          const configuredEnv = config.env && typeof config.env === 'object'
            ? config.env as Record<string, unknown>
            : {}
          config.env = { ...execution.env, ...configuredEnv }
        }
        return [target.name, config]
      })
  )
}

export function findMcpConfigByTargetId(
  targetId: string,
  cwd: string | undefined,
  homeDir: string
): ResolvedMcpConfig | null {
  return resolveMcpConfigs(cwd, homeDir).find((item) => item.targetId === targetId) ?? null
}

function strictToolNames(text: string, expectedId: number): string[] | null {
  const parse = (value: unknown): string[] | null => {
    if (!value || typeof value !== 'object') return null
    const message = value as { jsonrpc?: unknown; id?: unknown; result?: { tools?: unknown }; error?: unknown }
    if (
      message.jsonrpc !== '2.0' ||
      message.id !== expectedId ||
      Object.prototype.hasOwnProperty.call(message, 'error') ||
      !Array.isArray(message.result?.tools)
    ) return null
    const names: string[] = []
    for (const tool of message.result.tools) {
      if (!tool || typeof tool !== 'object' || typeof (tool as { name?: unknown }).name !== 'string') return null
      names.push((tool as { name: string }).name)
    }
    return names
  }
  try {
    const direct = parse(JSON.parse(text))
    if (direct) return direct
  } catch {
    /* try SSE frames */
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^data:\s*(.+)$/)
    if (!match) continue
    try {
      const names = parse(JSON.parse(match[1]))
      if (names) return names
    } catch {
      /* ignore malformed frame */
    }
  }
  return null
}

export function testStdioMcp(
  cfg: Record<string, unknown>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  cwd?: string
): Promise<McpTestResult> {
  return new Promise((resolve) => {
    let done = false
    let proc: ReturnType<typeof spawn>
    let timeoutTimer: NodeJS.Timeout | undefined
    const finish = (r: McpTestResult): void => {
      if (done) return
      done = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      try {
        proc?.kill()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    const safeWrite = (message: Record<string, unknown>): void => {
      const stdin = proc?.stdin
      if (done || !stdin || stdin.destroyed || !stdin.writable) return
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error && !done) finish({ ok: false, error: `MCP stdin: ${error.message}` })
      })
    }
    try {
      proc = spawn(String(cfg.command), (cfg.args as string[]) || [], {
        cwd,
        env: { ...minimalMcpEnv(inheritedEnv), ...((cfg.env as Record<string, string>) || {}) },
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch (e) {
      resolve({ ok: false, error: String((e as Error).message) })
      return
    }
    timeoutTimer = setTimeout(() => finish({ ok: false, error: 'timeout 8s' }), 8000)
    let buf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        try {
          const o = JSON.parse(line)
          if (o.jsonrpc === '2.0' && o.id === 1 && o.result && !Object.prototype.hasOwnProperty.call(o, 'error')) {
            safeWrite({ jsonrpc: '2.0', method: 'notifications/initialized' })
            safeWrite({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
          } else if (o.id === 2) {
            const names = strictToolNames(line, 2)
            finish(names
              ? { ok: true, tools: names.length, toolNames: names }
              : { ok: false, error: 'tools/list 返回了无效 JSON-RPC 响应' })
          }
        } catch {
          /* partial frame */
        }
      }
    })
    proc.stdin?.on('error', (e: Error) => {
      if (!done) finish({ ok: false, error: `MCP stdin: ${e.message}` })
    })
    proc.on('error', (e: Error) => {
      finish({ ok: false, error: String(e.message) })
    })
    proc.on('exit', (code: number | null) => {
      if (!done) finish({ ok: false, error: `exit ${code ?? 'unknown'}` })
    })
    safeWrite({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scry', version: '1' } }
    })
  })
}

export async function testHttpMcp(cfg: Record<string, unknown>): Promise<McpTestResult> {
  const url = String(cfg.url)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...((cfg.headers as Record<string, string>) || {})
  }
  const rpc = (id: number | undefined, method: string, h: Record<string, string>): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(id != null ? { id } : {}),
        method,
        ...(method === 'initialize'
          ? { params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scry', version: '1' } } }
          : {})
      }),
      signal: AbortSignal.timeout(8000)
    })
  try {
    const initRes = await rpc(1, 'initialize', headers)
    if (!initRes.ok) return { ok: false, error: `HTTP ${initRes.status}` }
    const sid = initRes.headers.get('mcp-session-id')
    const h2 = sid ? { ...headers, 'mcp-session-id': sid } : headers
    try {
      await rpc(undefined, 'notifications/initialized', h2)
    } catch {
      /* ignore */
    }
    const toolsRes = await rpc(2, 'tools/list', h2)
    if (!toolsRes.ok) return { ok: false, error: `tools/list HTTP ${toolsRes.status}` }
    const names = strictToolNames(await toolsRes.text(), 2)
    if (!names) return { ok: false, error: 'tools/list 返回了无效 JSON-RPC 响应' }
    return { ok: true, tools: names.length, toolNames: names }
  } catch (e) {
    return { ok: false, error: String((e as Error).message) }
  }
}

export function testMcpConfig(
  cfg: Record<string, unknown>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  cwd?: string
): Promise<McpTestResult> {
  if (cfg.url || cfg.type === 'http' || cfg.type === 'sse') return testHttpMcp(cfg)
  return testStdioMcp(cfg, inheritedEnv, cwd)
}

export function toggleMcp(name: string, enabled: boolean, cwd: string | undefined, homeDir: string): boolean {
  if (!cwd) return false
  const file = join(homeDir, '.claude.json')
  const cj = readJson(file)
  if (!cj) return false
  const projects = (cj.projects && typeof cj.projects === 'object' ? cj.projects : {}) as Record<string, Record<string, unknown>>
  const proj = (projects[cwd] && typeof projects[cwd] === 'object' ? projects[cwd] : {}) as Record<string, unknown>
  const disabled = new Set(Array.isArray(proj.disabledMcpjsonServers) ? (proj.disabledMcpjsonServers as string[]) : [])
  const enabledJson = new Set(Array.isArray(proj.enabledMcpjsonServers) ? (proj.enabledMcpjsonServers as string[]) : [])
  const disabledUser = new Set(Array.isArray(proj.disabledMcpServers) ? (proj.disabledMcpServers as string[]) : [])
  if (enabled) {
    disabled.delete(name)
    enabledJson.add(name)
    disabledUser.delete(name)
  } else {
    enabledJson.delete(name)
    disabled.add(name)
    disabledUser.add(name)
  }
  proj.disabledMcpjsonServers = [...disabled]
  proj.enabledMcpjsonServers = [...enabledJson]
  proj.disabledMcpServers = [...disabledUser]
  projects[cwd] = proj
  cj.projects = projects
  try {
    const tmp = file + '.scry.tmp'
    writeFileSync(tmp, JSON.stringify(cj, null, 2))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
