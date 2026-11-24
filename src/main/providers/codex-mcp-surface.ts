import {
  capabilityReady,
  capabilityUnknown,
  type McpAuthResult,
  type CapabilityEnvelope,
  type McpSnapshot,
  type ProviderContext
} from '../../shared/provider'
import { resolveProviderMcpConfigs } from '../mcp-config'
import { shellEnv } from '../claude-locate'
import { codexMcpOperations, codexMcpOAuthBlockReason } from './codex-mcp-config'
import { codexMcpStatus } from './codex-protocol'
import type { McpLiveStatus } from '../../shared/trace'
import { record } from './codex-trace'
import { isSafeOAuthAuthorizationUrl } from '../oauth-loopback'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import type { CodexAppServerClient } from './codex-app-server'
import type { CodexClientPool } from './codex-client-pool'
import type { AuthorizedMcpExecution, McpAuthInteraction } from './types'

const CODEX_MCP_OAUTH_TIMEOUT_MS = 120_000
const CODEX_MCP_CONNECT_TIMEOUT_MS = 5_000
const CODEX_MCP_CONNECT_POLL_MS = 100

interface CodexMcpOAuthCompleted {
  name: string
  threadId: string | null
  success: boolean
  error?: string
}

/**
 * Codex MCP surface: configuration snapshot, live runtime status from the app-server, and the
 * browser OAuth round trip. Needs the pool's request path but nothing from the run loop.
 */
export function createCodexMcpSurface(options: {
  homeDir: string
  request: CodexClientPool['request']
  getClient: CodexClientPool['getClient']
  shutdownClient: CodexClientPool['shutdownClient']
}) {
  const { homeDir, request, getClient, shutdownClient } = options
  return {
  snapshot: async (
    context: ProviderContext,
    refresh = false,
    execution?: AuthorizedMcpExecution
  ): Promise<CapabilityEnvelope<McpSnapshot>> => {
    const resolved = resolveProviderMcpConfigs('codex', context.cwd, homeDir, shellEnv())
    const configured = resolved.map(({
      sourcePath: _sourcePath,
      jsonPointer: _jsonPointer,
      config: _config,
      executableIdentity: _executableIdentity,
      ...item
    }) => item)
    const operations = codexMcpOperations(resolved)
    if (!refresh) {
      return {
        ...capabilityReady(context, 'read', { configured, runtime: null, operations }),
        state: 'degraded',
        reason: '配置已读取；刷新后才会启动已授权 MCP 并读取 Codex app-server 运行状态'
      }
    }
    if (!configured.some((item) => item.enabled)) {
      return capabilityReady(context, 'read', { configured, runtime: [], operations })
    }
    if (!execution) return capabilityUnknown<McpSnapshot>(context, 'read', '缺少已确认的 Codex MCP 执行快照')
    try {
      const response = await request(
        'mcpServerStatus/list',
        { threadId: context.externalSessionId ?? null, detail: 'full' },
        context.cwd,
        [],
        execution
      )
      return capabilityReady(context, 'read', { configured, runtime: codexMcpStatus(response), operations })
    } catch (error) {
      return capabilityUnknown<McpSnapshot>(context, 'read', sanitizeMcpAuthError(error))
    }
  },
  reauthenticate: async (
    context: ProviderContext,
    targetId: string,
    execution: AuthorizedMcpExecution | undefined,
    interaction: McpAuthInteraction
  ): Promise<CapabilityEnvelope<McpAuthResult>> => {
    const failed = (error: unknown, authenticated = false): CapabilityEnvelope<McpAuthResult> =>
      capabilityReady(context, 'read', {
        ok: false,
        status: authenticated ? 'authenticated-unverified' : 'failed',
        error: sanitizeMcpAuthError(error)
      })
    if (!execution) return failed('缺少绑定当前配置快照的 MCP 执行授权')
    if (execution.cwd !== context.cwd) return failed('MCP 执行授权与当前工作目录不匹配')
    const target = execution.targets.find((item) => item.targetId === targetId)
    if (!target) return failed('找不到精确配置目标')
    if (!target.enabled) return failed('当前 MCP 已停用')
    const oauthBlockReason = codexMcpOAuthBlockReason(target.config)
    if (oauthBlockReason) return failed(oauthBlockReason)
    if (execution.targets.some((item) => item.targetId !== targetId && item.enabled && item.name === target.name)) {
      return failed(`Codex 存在多个同名 MCP ${target.name}，无法安全绑定认证目标`)
    }
    const authExecution: AuthorizedMcpExecution = {
      ...execution,
      fingerprint: `${execution.fingerprint}:auth:${target.targetId}`,
      targets: [target]
    }

    const threadId = context.externalSessionId ?? null
    let client: CodexAppServerClient | undefined
    let unsubscribe = () => {}
    let timer: NodeJS.Timeout | undefined
    let finish: ((value: CodexMcpOAuthCompleted) => void) | undefined
    let authenticated = false
    try {
      client = getClient(context.cwd, [], authExecution)
      const authClient = client
      await authClient.start()
      const completed = new Promise<CodexMcpOAuthCompleted>((resolve) => {
        finish = resolve
        timer = setTimeout(() => resolve({
          name: target.name,
          threadId,
          success: false,
          error: '等待 Codex MCP 浏览器认证超时'
        }), CODEX_MCP_OAUTH_TIMEOUT_MS)
        unsubscribe = authClient.onNotification((method, value) => {
          if (method !== 'mcpServer/oauthLogin/completed') return
          const params = record(value)
          const notificationThreadId = typeof params.threadId === 'string' ? params.threadId : null
          if (params.name !== target.name || notificationThreadId !== threadId) return
          resolve({
            name: target.name,
            threadId,
            success: params.success === true,
            error: typeof params.error === 'string' ? params.error : undefined
          })
        })
      })
      const generationFailed = authClient.failureForCurrentGeneration().then((error): CodexMcpOAuthCompleted => ({
        name: target.name,
        threadId,
        success: false,
        error: error.message
      }))
      const login = await request<{ authorizationUrl?: unknown }>(
        'mcpServer/oauth/login',
        { name: target.name, threadId, timeoutSecs: CODEX_MCP_OAUTH_TIMEOUT_MS / 1_000 },
        context.cwd,
        [],
        authExecution
      )
      const authorizationUrl = typeof login.authorizationUrl === 'string' ? login.authorizationUrl : ''
      if (!isSafeOAuthAuthorizationUrl(authorizationUrl)) return failed('Codex 未返回安全的 MCP OAuth 授权地址')
      await interaction.openExternal(authorizationUrl)
      const outcome = await Promise.race([completed, generationFailed])
      if (!outcome.success) return failed(outcome.error || 'Codex MCP 认证失败')
      authenticated = true

      await request('config/mcpServer/reload', undefined, context.cwd, [], authExecution)
      const deadline = Date.now() + CODEX_MCP_CONNECT_TIMEOUT_MS
      let refreshed: McpLiveStatus | undefined
      do {
        const status = await request(
          'mcpServerStatus/list',
          { threadId, detail: 'toolsAndAuthOnly' },
          context.cwd,
          [],
          authExecution
        )
        refreshed = codexMcpStatus(status).find((item) => item.name === target.name)
        if (refreshed?.status === 'connected' || (refreshed && refreshed.status !== 'pending')) break
        await new Promise((resolve) => setTimeout(resolve, CODEX_MCP_CONNECT_POLL_MS))
      } while (Date.now() < deadline)
      if (refreshed?.status !== 'connected') {
        return failed(refreshed?.status === 'needs-auth'
          ? 'Codex 完成认证后仍报告需要登录'
          : `Codex 完成认证后连接状态为 ${refreshed?.status ?? 'unknown'}`, true)
      }
      return capabilityReady(context, 'read', { ok: true, status: 'authenticated' })
    } catch (error) {
      return failed(error, authenticated)
    } finally {
      if (timer) clearTimeout(timer)
      unsubscribe()
      finish?.({ name: target.name, threadId, success: false, error: '认证已取消' })
      if (client) await shutdownClient(client)
    }
  }
  }
}
