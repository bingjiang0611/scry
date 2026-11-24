import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { historyReaderEnvironment, type HistoryReaderConnection } from '../conversation-history-reader'
import { resolveRuntimeCliBin, runtimeCliEnv } from '../claude-locate'
import type { CodexHookTrustGrant } from '../codex-hook-trust'
import { CodexAppServerClient } from './codex-app-server'
import { createCodexIsolatedHome } from './codex-isolated-home'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import { codexMcpConfig } from './codex-mcp-config'
import type { AuthorizedMcpExecution } from './types'
import { ContinuationIdentityUnavailable, codexContinuationKey } from './continuation-identity'

/** C1: a Codex app-server stays for the idle window, then the pool releases it with a reason. */
export const CODEX_IDLE_MIN_MS = 15 * 60_000
export const CODEX_IDLE_MAX_MS = 30 * 60_000
export const CODEX_IDLE_DEFAULT_MS = 20 * 60_000
export const CODEX_CLIENT_CAP = 8

export function codexIdleWindowMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = Number(env.SCRY_CODEX_IDLE_MS)
  if (!Number.isFinite(raw) || raw <= 0) return CODEX_IDLE_DEFAULT_MS
  return Math.min(CODEX_IDLE_MAX_MS, Math.max(CODEX_IDLE_MIN_MS, raw))
}

/** Released facts, not log lines: the host stores these as the session's lifecycle. */
export interface CodexSessionObserver {
  onOpened?: (key: string, provider: 'codex', at: number) => void
  onNativeSessionId?: (key: string, nativeSessionId: string) => void
  onReleased?: (key: string, reason: 'idle' | 'lru' | 'dispose', at: number) => void
}

/**
 * Codex app-server clients are expensive: one process owns threads, MCP servers and hook state.
 * The pool keeps one client per (cwd, hook trust, MCP, continuation identity, history reader) key,
 * releases it after the C1 idle window, and stays under a hard LRU cap.
 */
export interface CodexClientPool {
  getClient: (
    cwd?: string,
    hookTrust?: CodexHookTrustGrant[],
    mcpExecution?: AuthorizedMcpExecution,
    expectedContinuationKey?: string,
    historyReader?: HistoryReaderConnection
  ) => CodexAppServerClient
  shutdownClient: (client: CodexAppServerClient) => Promise<void>
  scheduleClientShutdown: (client: CodexAppServerClient) => void
  request: <T>(
    method: string,
    params?: unknown,
    cwd?: string,
    hookTrust?: CodexHookTrustGrant[],
    mcpExecution?: AuthorizedMcpExecution,
    expectedContinuationKey?: string,
    historyReader?: HistoryReaderConnection
  ) => Promise<T>
  readonly clientActivity: Map<CodexAppServerClient, number>
  readonly clientActiveRuns: Map<CodexAppServerClient, number>
  /** Health is read, not inferred: the pool is the only writer of these fields. */
  health: () => {
    pid: number | undefined
    lastOkAt: number | undefined
    lastErrorAt: number | undefined
    lastError: string | undefined
    restarts: number
  }
  executable: () => string | undefined
  runtimeEnvironment: () => Record<string, string>
  sourceHomeFor: (env: Readonly<Record<string, string>>) => string
  ensureIsolatedHome: (sourceHome: string) => ReturnType<typeof createCodexIsolatedHome>
  /** The isolated home the pool materialised, if any; identity checks read the same value. */
  isolatedState: () => { home: ReturnType<typeof createCodexIsolatedHome> | undefined; sourceHome: string | undefined }
  /** C1: the thread this client carries, reported once the app-server names it. */
  recordNativeSession: (client: CodexAppServerClient, threadId: string) => void
  closeAll: () => Promise<void>
}

export function createCodexClientPool(options: {
  isolatedHomePath?: string
  homeDir: string
  sessions?: CodexSessionObserver
  /** Tests pin the window; production reads the C1 clamp from the environment. */
  idleWindowMs?: number
  maxClients?: number
}): CodexClientPool {
  const { isolatedHomePath, homeDir, sessions } = options
  const CLIENT_IDLE_MS = options.idleWindowMs ?? codexIdleWindowMs(process.env)
  const CLIENT_CAP = options.maxClients ?? CODEX_CLIENT_CAP
  const clients = new Map<string, CodexAppServerClient>()
const clientActivity = new Map<CodexAppServerClient, number>()
/** A5：每个共享 client 上正在进行的 run 数；硬杀只回收计数为 1 的 client。 */
const clientActiveRuns = new Map<CodexAppServerClient, number>()
const clientLastUsed = new Map<CodexAppServerClient, number>()
const clientIdleTimers = new Map<CodexAppServerClient, ReturnType<typeof setTimeout>>()
// Stdio MCP env files live as long as the pooled client that may (re)start the servers.
const clientFiles = new Map<CodexAppServerClient, () => void>()
const releaseClientFiles = (client: CodexAppServerClient): void => {
  const dispose = clientFiles.get(client)
  clientFiles.delete(client)
  dispose?.()
}
let lastClient: CodexAppServerClient | null = null
let lastOkAt: number | undefined
let lastErrorAt: number | undefined
let lastError: string | undefined
let restarts = 0
let isolatedHome: ReturnType<typeof createCodexIsolatedHome> | undefined
let isolatedSourceHome: string | undefined

const executable = (): string | undefined => process.env.SCRY_CODEX_PATH?.trim() || resolveRuntimeCliBin('codex')
const runtimeEnvironment = (): Record<string, string> => {
  const env = runtimeCliEnv(undefined, { managedRecorder: true, providerId: 'codex' })
  // runtimeCliEnv may be a deliberately minimal test/launcher environment; keep the
  // adapter's configured home explicit so source-home derivation uses the same env key.
  return { ...env, HOME: env.HOME ?? homeDir }
}
const sourceHomeFor = (env: Readonly<Record<string, string>>): string => {
  const configured = process.env.SCRY_CODEX_SOURCE_HOME?.trim() || env.CODEX_HOME?.trim()
  if (configured) return configured
  if (env.HOME?.trim()) return join(env.HOME, '.codex')
  throw new ContinuationIdentityUnavailable('Codex runtime HOME 不可用')
}
const ensureIsolatedHome = (sourceHome: string): ReturnType<typeof createCodexIsolatedHome> => {
  if (isolatedHome) {
    if (isolatedSourceHome !== sourceHome) {
      throw new ContinuationIdentityUnavailable('Codex source home 已变化；请重启 Provider 后再继续')
    }
    return isolatedHome
  }
  isolatedHome = createCodexIsolatedHome(sourceHome, isolatedHomePath)
  isolatedSourceHome = sourceHome
  return isolatedHome
}
const keyOf = (client: CodexAppServerClient): string | undefined => {
  for (const [key, cached] of clients) if (cached === client) return key
  return undefined
}
const releaseReason = new WeakMap<CodexAppServerClient, 'idle' | 'lru' | 'dispose'>()
const evictIdleClients = (protectedClient?: CodexAppServerClient): void => {
  const unique = [...new Set(clients.values())]
  if (unique.length <= CLIENT_CAP) return
  const idle = unique
    .filter((client) => client !== protectedClient && (clientActivity.get(client) ?? 0) === 0)
    .sort((left, right) => (clientLastUsed.get(left) ?? 0) - (clientLastUsed.get(right) ?? 0))
  for (const client of idle.slice(0, Math.max(0, unique.length - CLIENT_CAP))) {
    releaseReason.set(client, 'lru')
    void shutdownClient(client)
  }
}
const scheduleClientShutdown = (client: CodexAppServerClient): void => {
  const previous = clientIdleTimers.get(client)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    clientIdleTimers.delete(client)
    if ((clientActivity.get(client) ?? 0) > 0) {
      scheduleClientShutdown(client)
      return
    }
    releaseReason.set(client, 'idle')
    void shutdownClient(client)
  }, CLIENT_IDLE_MS)
  timer.unref()
  clientIdleTimers.set(client, timer)
}
const getClient = (
  cwd?: string,
  hookTrust: CodexHookTrustGrant[] = [],
  mcpExecution?: AuthorizedMcpExecution,
  expectedContinuationKey?: string,
  historyReader?: HistoryReaderConnection
): CodexAppServerClient => {
  const trustedHooks = [...hookTrust].sort((left, right) => left.key.localeCompare(right.key))
  const trustKey = trustedHooks.map((hook) => `${hook.key}\0${hook.currentHash}`).join('\n')
  const env = runtimeEnvironment()
  const sourceHome = sourceHomeFor(env)
  const privateHome = ensureIsolatedHome(sourceHome)
  let identity = ''
  if (expectedContinuationKey) {
    identity = codexContinuationKey(
      { providerId: 'codex', ...(cwd ? { cwd } : {}) },
      sourceHome,
      privateHome.path,
      executable(),
      env,
      'materialized'
    )
    if (identity !== expectedContinuationKey) {
      throw new ContinuationIdentityUnavailable('Codex 接续身份已变化，请重新预览')
    }
  }
  const readerKey = historyReader ? createHash('sha256').update(JSON.stringify(historyReader)).digest('hex') : 'none'
  const key = `${cwd ?? ''}\0${trustKey}\0${mcpExecution?.fingerprint ?? 'none'}\0${identity}\0${readerKey}`
  const existing = clients.get(key)
  if (existing) {
    const timer = clientIdleTimers.get(existing)
    if (timer) clearTimeout(timer)
    clientIdleTimers.delete(existing)
    clientLastUsed.set(existing, Date.now())
    lastClient = existing
    return existing
  }
  const path = executable()
  if (!path) throw new Error('Codex CLI 未找到')
  if (lastErrorAt) restarts++
  delete env.SCRY_CODEX_SOURCE_HOME
  const appServerArgs = [
    'app-server',
    '--strict-config',
    '--disable', 'apps',
    '--disable', 'plugins',
    '--disable', 'remote_plugin',
    '--disable', 'external_migration',
    '--disable', 'skill_mcp_dependency_install'
  ]
  // Trusted project configs may define optional profiles without a default; app-server strict mode still requires one.
  const projectTrustArgs = cwd
    ? [
        '-c', `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`,
        '-c', 'default_permissions=":workspace"'
      ]
    : []
  const hookTrustArgs = trustedHooks.length > 0
    ? ['-c', `hooks={state={${trustedHooks.map((hook) =>
        `${JSON.stringify(hook.key)}={trusted_hash=${JSON.stringify(hook.currentHash)}}`
      ).join(',')}}}`]
    : []
  const mcp = codexMcpConfig(mcpExecution, historyReader)
  const args = [
    ...projectTrustArgs,
    ...hookTrustArgs,
    ...mcp.args,
    ...appServerArgs
  ]
  let client: CodexAppServerClient
  try {
    client = new CodexAppServerClient({
      command: path,
      args,
      cwd,
      env: { ...(historyReader ? historyReaderEnvironment(env) : env), CODEX_HOME: privateHome.path, ...(historyReader ? { SCRY_HISTORY_READER_TOKEN: historyReader.token } : {}), ...mcp.env }
    })
  } catch (error) {
    mcp.dispose?.()
    throw error
  }
  if (mcp.dispose) clientFiles.set(client, mcp.dispose)
  clients.set(key, client)
  sessions?.onOpened?.(key, 'codex', Date.now())
  clientLastUsed.set(client, Date.now())
  lastClient = client
  evictIdleClients(client)
  return client
}

const shutdownClient = async (client: CodexAppServerClient): Promise<void> => {
  const timer = clientIdleTimers.get(client)
  if (timer) clearTimeout(timer)
  clientIdleTimers.delete(client)
  clientActivity.delete(client)
  clientActiveRuns.delete(client)
  clientLastUsed.delete(client)
  let registered = false
  let keyOfReleasedClient: string | undefined
  for (const [key, cached] of clients) {
    if (cached !== client) continue
    registered = true
    keyOfReleasedClient = key
    clients.delete(key)
  }
  if (lastClient === client) lastClient = null
  try {
    if (registered) await client.shutdown()
  } finally {
    releaseClientFiles(client)
    if (registered) {
      sessions?.onReleased?.(keyOfReleasedClient ?? '', releaseReason.get(client) ?? 'dispose', Date.now())
      releaseReason.delete(client)
    }
  }
}

const request = async <T>(
  method: string,
  params?: unknown,
  cwd?: string,
  hookTrust: CodexHookTrustGrant[] = [],
  mcpExecution?: AuthorizedMcpExecution,
  expectedContinuationKey?: string,
  historyReader?: HistoryReaderConnection
): Promise<T> => {
  const client = getClient(cwd, hookTrust, mcpExecution, expectedContinuationKey, historyReader)
  clientActivity.set(client, (clientActivity.get(client) ?? 0) + 1)
  try {
    const result = await client.request<T>(method, params)
    lastOkAt = Date.now()
    lastError = undefined
    return result
  } catch (error) {
    lastErrorAt = Date.now()
    lastError = sanitizeMcpAuthError(error)
    throw error
  } finally {
    const active = Math.max(0, (clientActivity.get(client) ?? 1) - 1)
    if (active > 0) clientActivity.set(client, active)
    else clientActivity.delete(client)
    clientLastUsed.set(client, Date.now())
    scheduleClientShutdown(client)
    evictIdleClients()
  }
}

  return {
    getClient,
    shutdownClient,
    scheduleClientShutdown,
    request,
    clientActivity,
    clientActiveRuns,
    health: () => ({ pid: lastClient?.pid, lastOkAt, lastErrorAt, lastError, restarts }),
    executable,
    runtimeEnvironment,
    sourceHomeFor,
    ensureIsolatedHome,
    isolatedState: () => ({ home: isolatedHome, sourceHome: isolatedSourceHome }),
    recordNativeSession: (client, threadId) => {
      const key = keyOf(client)
      if (key) sessions?.onNativeSessionId?.(key, threadId)
    },
    closeAll: async () => {
      for (const client of [...new Set(clients.values())]) await shutdownClient(client)
    }
  }
}
