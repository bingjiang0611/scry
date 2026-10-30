import { query, type McpServerStatus } from '@qoder-ai/qoder-agent-sdk'
import {
  capabilityReady,
  capabilityUnknown,
  type CapabilityEnvelope,
  type McpAuthResult,
  type McpSnapshot,
  type ProviderContext
} from '../../shared/provider'
import type { McpLiveStatus } from '../../shared/trace'
import { shellEnv } from '../claude-locate'
import { isRemoteMcpConfig, listProviderMcp } from '../mcp-config'
import { isSafeOAuthAuthorizationUrl } from '../oauth-loopback'
import { sanitizeMcpAuthError } from './mcp-auth-security'
import { heldPrompt, qoderOptions } from './qoder-launch'
import type { AuthorizedMcpExecution, McpAuthInteraction } from './types'

const QODER_MCP_AUTH_TIMEOUT_MS = 120_000

export function qoderAuthenticationTargets(configured: McpSnapshot['configured']): string[] {
  const enabledNames = new Map<string, number>()
  for (const item of configured) {
    if (item.enabled) enabledNames.set(item.name, (enabledNames.get(item.name) ?? 0) + 1)
  }
  return configured
    .filter((item) => item.enabled && enabledNames.get(item.name) === 1 && item.transport === 'http' && item.targetId)
    .map((item) => item.targetId!)
}

export function qoderMcpSnapshot(statuses: McpServerStatus[], configured?: McpSnapshot['configured']): McpSnapshot {
  const runtime: McpLiveStatus[] = statuses.map((server) => ({
    name: server.name,
    status: server.status,
    serverName: server.serverInfo?.name,
    serverVersion: server.serverInfo?.version,
    tools: server.tools?.length,
    toolNames: server.tools?.map((tool) => tool.name)
  }))
  const snapshotConfigured: McpSnapshot['configured'] = configured ?? statuses.map((server) => {
    const config = server.config
    const transport = config && 'type' in config ? config.type ?? 'stdio' : 'stdio'
    const detail = config && 'url' in config ? config.url : config && 'command' in config ? config.command : server.error ?? server.status
    return { name: server.name, scope: server.scope ?? 'qoder', transport, detail, enabled: server.status !== 'disabled' }
  })
  return {
    configured: snapshotConfigured,
    runtime,
    operations: {
      authenticate: qoderAuthenticationTargets(snapshotConfigured)
    }
  }
}


export async function readQoderMcpSnapshot(
  homeDir: string,
  context: ProviderContext,
  refresh = false,
  execution?: AuthorizedMcpExecution
): Promise<CapabilityEnvelope<McpSnapshot>> {
  const configured = listProviderMcp('qoder', context.cwd, homeDir, shellEnv())
  const operations = { authenticate: qoderAuthenticationTargets(configured) }
  const base: McpSnapshot = { configured, runtime: null, operations }
  if (!refresh) {
    return {
      ...capabilityReady(context, 'read', base),
      state: 'degraded',
      reason: '配置已读取；刷新后才会启动已授权 MCP 并读取 Qoder 原生运行状态'
    }
  }
  if (!configured.some((item) => item.enabled)) {
    return capabilityReady(context, 'read', { configured, runtime: [], operations })
  }
  if (!execution) {
    return capabilityUnknown<McpSnapshot>(context, 'read', '缺少已确认的 Qoder MCP 执行快照')
  }
  const prompt = heldPrompt()
  const q = query({ prompt: prompt.stream, options: qoderOptions(context.cwd, undefined, undefined, undefined, 'default', false, execution) as never })
  try {
    await q.initializationResult()
    return capabilityReady(context, 'read', qoderMcpSnapshot(await q.mcpServerStatus(), configured))
  } catch (error) {
    return capabilityUnknown<McpSnapshot>(context, 'read', sanitizeMcpAuthError(error))
  } finally {
    prompt.release()
    await Promise.resolve(q.close()).catch(() => {})
  }
}

export async function reauthenticateQoderMcp(
  context: ProviderContext,
  targetId: string,
  execution: AuthorizedMcpExecution | undefined,
  interaction: McpAuthInteraction
): Promise<CapabilityEnvelope<McpAuthResult>> {
  const failed = (error: unknown, authenticated = false) => capabilityReady(context, 'read', {
    ok: false,
    status: authenticated ? 'authenticated-unverified' as const : 'failed' as const,
    error: sanitizeMcpAuthError(error)
  })
  if (!execution) return failed('缺少绑定当前配置快照的 MCP 执行授权')
  if (execution.cwd !== context.cwd) return failed('MCP 执行授权与当前工作目录不匹配')
  const target = execution.targets.find((item) => item.targetId === targetId)
  if (!target) return failed('已确认的 Qoder MCP 执行快照中不存在该目标')
  if (!target.enabled) return failed(`Qoder MCP ${target.name} 当前已停用`)
  if (!isRemoteMcpConfig(target.config)) return failed('stdio MCP 不支持 OAuth 重新认证')
  if (execution.targets.some((item) => item.targetId !== targetId && item.enabled && item.name === target.name)) {
    return failed(`Qoder 存在多个同名 MCP ${target.name}，无法安全绑定认证目标`)
  }

  let loopback: Awaited<ReturnType<McpAuthInteraction['prepareLoopbackCallback']>>
  try {
    loopback = await interaction.prepareLoopbackCallback()
  } catch (error) {
    return failed(error)
  }

  const prompt = heldPrompt()
  const q = query({
    prompt: prompt.stream,
    options: {
      ...qoderOptions(context.cwd, undefined, undefined, undefined, 'default', false, {
        ...execution,
        targets: [target]
      }),
      persistSession: false
    } as never
  })
  let authenticated = false
  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  const assertActive = (): void => {
    if (timedOut) throw new Error('等待 Qoder MCP 浏览器认证超时')
  }
  try {
    return await Promise.race([
      (async () => {
        await q.initializationResult()
        assertActive()
        const auth = await q.mcpAuthenticate(target.name, loopback.redirectUri)
        assertActive()
        if (auth.requiresUserAction) {
          if (!auth.authUrl) throw new Error('Qoder 未返回 OAuth 授权地址')
          if (!isSafeOAuthAuthorizationUrl(auth.authUrl)) throw new Error('Qoder 返回了不安全的 OAuth 授权地址')
          await interaction.openExternal(auth.authUrl)
          assertActive()
          await q.mcpSubmitOAuthCallbackUrl(target.name, await loopback.waitForCallback())
          assertActive()
        }
        authenticated = true
        const status = (await q.mcpServerStatus()).find((server) => server.name === target.name)
        assertActive()
        if (status?.status !== 'connected') {
          throw new Error(status?.error || `Qoder MCP ${target.name} 认证后状态为 ${status?.status ?? 'unknown'}`)
        }
        return capabilityReady(context, 'read', { ok: true, status: 'authenticated' as const })
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error('等待 Qoder MCP 浏览器认证超时'))
        }, QODER_MCP_AUTH_TIMEOUT_MS)
        timer.unref()
      })
    ])
  } catch (error) {
    return failed(error, authenticated)
  } finally {
    if (timer) clearTimeout(timer)
    try {
      loopback.close()
    } finally {
      prompt.release()
      const close = Promise.resolve(q.close()).catch(() => {})
      if (timedOut) void close
      else await close
    }
  }
}
