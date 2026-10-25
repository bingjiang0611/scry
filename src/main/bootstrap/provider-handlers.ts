import { shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderContext, ProviderId } from '../../shared/provider'
import type { ProviderRegistry } from '../providers/registry'
import type { McpExecutionOperation, McpExecutionSnapshot } from '../mcp-execution-trust'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { AuthorizedMcpExecution } from '../providers/types'
import { capabilityUnavailable } from '../../shared/provider'
import { isSafeOAuthAuthorizationUrl, prepareOAuthLoopback } from '../oauth-loopback'
import { buildMcpExecutionSnapshot } from '../mcp-execution-trust'
import { isMcpGuardReport } from '../../shared/mcpguard-report'
import { providerOperationKey } from '../provider-operation-gate'
import { shellEnv } from '../claude-locate'

export interface ProviderHandlersDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  providerRegistry: ProviderRegistry
  withProviderOperation: <T>(providerId: ProviderId, operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>
  getRemoteProviderDiscovery: () => { invalidate: (providerId: ProviderId) => void }
  refreshInvalidatedRemoteProviderMetadata: () => void
  ensureMcpExecutionAuthorized: (context: ProviderContext, operation: McpExecutionOperation, targetId?: string) => Promise<McpExecutionSnapshot | null>
  authorizedMcpExecution: (snapshot: McpExecutionSnapshot | null) => AuthorizedMcpExecution | undefined
  homeDir: string
  getCurrentCwd: () => string | undefined
  getRuns: () => { activeStates: () => Array<{ done: boolean; providerId?: ProviderId }> }
  canonicalProviderCwd: (cwd?: string) => string
  providerOperationKey: typeof providerOperationKey
  providerOperationGate: ProviderOperationGate
}

export function registerProviderHandlers(deps: ProviderHandlersDependencies): void {
  const { handleTrusted, providerRegistry, withProviderOperation, getRemoteProviderDiscovery, refreshInvalidatedRemoteProviderMetadata, ensureMcpExecutionAuthorized, authorizedMcpExecution, homeDir, getCurrentCwd, getRuns, canonicalProviderCwd, providerOperationKey, providerOperationGate } = deps
  handleTrusted('agent:invalidateProviderContext', async (_event, context: ProviderContext) => {
    const normalizedContext = { ...context, cwd: context.cwd ?? getCurrentCwd() }
    providerRegistry.get(normalizedContext.providerId)
    await withProviderOperation(normalizedContext.providerId, async () => {
      getRemoteProviderDiscovery().invalidate(normalizedContext.providerId)
      try {
        await providerRegistry.invalidateContext(normalizedContext)
      } finally {
        refreshInvalidatedRemoteProviderMetadata()
      }
    }, normalizedContext.agentProfileId)
    return true
  })
  handleTrusted('agent:listSkills', (_e, context: ProviderContext) =>
    withProviderOperation(context.providerId, () => providerRegistry.listSkills(context), context.agentProfileId)
  )
  handleTrusted('agent:mcpSnapshot', async (_e, p: { context: ProviderContext; refresh?: boolean }) => {
    if (p.context.providerId === 'pi') {
      return withProviderOperation(
        p.context.providerId,
        () => providerRegistry.mcpSnapshot(p.context, p.refresh === true),
        p.context.agentProfileId
      )
    }
    if (!p.refresh) return providerRegistry.mcpSnapshot(p.context, false)
    return withProviderOperation(p.context.providerId, async () => {
      const snapshot = p.refresh ? await ensureMcpExecutionAuthorized(p.context, 'live') : null
      return providerRegistry.mcpSnapshot(p.context, p.refresh, authorizedMcpExecution(snapshot))
    }, p.context.agentProfileId)
  })
  handleTrusted('agent:testMcp', async (_e, p: { context: ProviderContext; targetId: string }) => {
    if (p.context.providerId === 'pi') return providerRegistry.testMcp(p.context, p.targetId)
    return withProviderOperation(p.context.providerId, async () => {
      const snapshot = await ensureMcpExecutionAuthorized(p.context, `test:${p.targetId}`, p.targetId)
      return providerRegistry.testMcp(p.context, p.targetId, authorizedMcpExecution(snapshot))
    }, p.context.agentProfileId)
  })
  handleTrusted('agent:reauthenticateMcp', async (_e, p: { context: ProviderContext; targetId: string }) => {
    const canonicalCwd = canonicalProviderCwd(p.context.cwd)
    const authKey = providerOperationKey(p.context.providerId, p.context.agentProfileId)
    const authLease = providerOperationGate.acquireAuthentication(authKey)
    if (!authLease.ok) {
      throw new Error(authLease.blockedBy === 'authentication'
        ? '当前 Provider 正在认证 MCP，请等待当前流程完成'
        : '当前 Provider 正在执行其他操作，请等待完成后再认证 MCP')
    }
    const active = getRuns().activeStates().find((run) => !run.done && run.providerId === p.context.providerId)
    if (active) {
      authLease.release()
      throw new Error('当前 Provider 正在执行会话，请等待本轮结束后再认证 MCP')
    }
    try {
      const snapshot = await ensureMcpExecutionAuthorized(p.context, `auth:${p.targetId}`, p.targetId)
      const normalizedContext = { ...p.context, cwd: snapshot?.cwd ?? canonicalCwd }
      const result = await providerRegistry.reauthenticateMcp(
        normalizedContext,
        p.targetId,
        authorizedMcpExecution(snapshot),
        {
          openExternal: async (url) => {
            if (!isSafeOAuthAuthorizationUrl(url)) throw new Error('Provider 返回了不安全的 MCP OAuth 授权地址')
            await shell.openExternal(url)
          },
          prepareLoopbackCallback: () => prepareOAuthLoopback()
        }
      )
      if (snapshot) {
        const verified = buildMcpExecutionSnapshot({
          providerId: p.context.providerId,
          cwd: p.context.cwd,
          homeDir,
          settingSources: p.context.providerId === 'claude' ? process.env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
          env: shellEnv(),
          selectedTargetId: p.targetId
        })
        if (verified.errors.length > 0 || verified.fingerprint !== snapshot.fingerprint) {
          if (result.data?.status === 'authenticated' || result.data?.status === 'authenticated-unverified') {
            return {
              ...result,
              data: {
                ok: false,
                status: 'authenticated-unverified' as const,
                error: '认证期间 MCP 配置发生变化；凭据可能已更新，但当前连接状态不再可信，请重新检测'
              }
            }
          }
          throw new Error('MCP 配置在认证期间发生变化；本次状态不再可信，请重新检测后操作')
        }
      }
      return result
    } finally {
      authLease.release()
    }
  })
  handleTrusted('agent:mcpGuardScan', (_e, context: ProviderContext) => {
    if (providerRegistry.isDisabled(context.providerId)) {
      return capabilityUnavailable(context, 'unsupported', '该 Provider 已通过 SCRY_DISABLED_PROVIDERS 禁用')
    }
    if (context.providerId === 'pi') {
      return capabilityUnavailable(context, 'unsupported', 'Pi snapshot 仅返回脱敏后的有效配置与运行态，不包含 MCP Guard 所需的可执行配置和凭据指纹')
    }
    const snapshot = buildMcpExecutionSnapshot({
      providerId: context.providerId,
      cwd: context.cwd,
      homeDir,
      settingSources: context.providerId === 'claude' ? process.env.SCRY_CLAUDE_SETTING_SOURCES : undefined,
      env: shellEnv()
    })
    const report = snapshot.report
    if (!isMcpGuardReport(report)) throw new Error('mcpguard 生成了不一致的扫描报告')
    const issues = [...snapshot.errors, ...snapshot.warnings]
    return {
      ...context,
      mode: 'read',
      state: issues.length > 0 ? 'degraded' : 'ready',
      data: report,
      ...(issues.length > 0 ? { reason: issues.join('；') } : {}),
      observedAt: Date.now()
    }
  })
  handleTrusted('agent:listCommands', (_e, context: ProviderContext) =>
    withProviderOperation(context.providerId, () => providerRegistry.listCommands(context), context.agentProfileId)
  )
  handleTrusted('agent:runControls', (_e, context: ProviderContext) =>
    withProviderOperation(context.providerId, () => providerRegistry.runControls(context), context.agentProfileId)
  )


}
