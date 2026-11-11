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
import type { ChannelHandlers } from './startup-channels'

// The four MCP channels, as main has always answered them, shared with the daemon
// (B4-L4) so daemon mode runs the same trust and fingerprint checks: every live probe,
// test and re-auth re-verifies the MCP execution snapshot and fails closed. What differs
// is injected: who may authenticate here, and how an OAuth page reaches a browser (main
// opens it; the daemon hands it to its App, which opens it only for its own request).

export interface McpChannelDependencies {
  providerRegistry: ProviderRegistry
  withProviderOperation: <T>(providerId: ProviderId, operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>
  ensureMcpExecutionAuthorized: (context: ProviderContext, operation: McpExecutionOperation, targetId?: string) => Promise<McpExecutionSnapshot | null>
  authorizedMcpExecution: (snapshot: McpExecutionSnapshot | null) => AuthorizedMcpExecution | undefined
  homeDir: string
  getRuns: () => { activeStates: () => Array<{ done: boolean; providerId?: ProviderId }> }
  canonicalProviderCwd: (cwd?: string) => string
  providerOperationGate: ProviderOperationGate
  /** Called with a URL already checked by isSafeOAuthAuthorizationUrl. */
  openExternal: (url: string) => Promise<void>
  /** Refuses where this process must not authenticate (main under the daemon switch). */
  assertOwner: () => void
}

export function mcpChannelHandlers(deps: McpChannelDependencies) {
  const { providerRegistry, withProviderOperation, ensureMcpExecutionAuthorized, authorizedMcpExecution, homeDir, getRuns, canonicalProviderCwd, providerOperationGate, openExternal, assertOwner } = deps
  return {
    'agent:mcpSnapshot': async (p: { context: ProviderContext; refresh?: boolean }) => {
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
    },
    'agent:testMcp': async (p: { context: ProviderContext; targetId: string }) => {
      assertOwner()
      if (p.context.providerId === 'pi') return providerRegistry.testMcp(p.context, p.targetId)
      return withProviderOperation(p.context.providerId, async () => {
        const snapshot = await ensureMcpExecutionAuthorized(p.context, `test:${p.targetId}`, p.targetId)
        return providerRegistry.testMcp(p.context, p.targetId, authorizedMcpExecution(snapshot))
      }, p.context.agentProfileId)
    },
    'agent:reauthenticateMcp': async (p: { context: ProviderContext; targetId: string }) => {
      assertOwner()
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
              await openExternal(url)
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
    },
    'agent:mcpGuardScan': (context: ProviderContext) => {
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
    }
  } satisfies ChannelHandlers
}
