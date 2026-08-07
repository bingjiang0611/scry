import {
  capabilityReady,
  capabilityUnavailable,
  type AccountSnapshot,
  type CapabilityEnvelope,
  type McpAuthResult,
  type McpSnapshot,
  type McpTestResult,
  type ProviderCommand,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderId,
  type SkillMeta
} from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import type {
  AuthorizedMcpExecution,
  McpAuthInteraction,
  ProviderAdapter,
  ProviderRunHandle,
  ProviderRunRequest
} from './types'
import type { CodexHookInspection } from '../codex-hook-trust'

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>()
  private readonly disabledProviders: ReadonlySet<ProviderId>
  private readonly runControlsEnabled: boolean

  constructor(
    adapters: ProviderAdapter[],
    options: { disabledProviders?: ReadonlySet<ProviderId>; runControlsEnabled?: boolean } = {}
  ) {
    this.disabledProviders = options.disabledProviders ?? new Set()
    this.runControlsEnabled = options.runControlsEnabled ?? true
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new Error(`duplicate provider adapter: ${adapter.id}`)
      this.adapters.set(adapter.id, adapter)
    }
  }

  get(providerId: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(providerId)
    if (!adapter) throw new Error(`provider adapter not registered: ${providerId}`)
    return adapter
  }

  isDisabled(providerId: ProviderId): boolean {
    return this.disabledProviders.has(providerId)
  }

  private disabled<T>(context: ProviderContext): Promise<CapabilityEnvelope<T>> | null {
    return this.isDisabled(context.providerId)
      ? Promise.resolve(capabilityUnavailable(context, 'unsupported', `该 Provider 已通过 SCRY_DISABLED_PROVIDERS 禁用`))
      : null
  }

  run(providerId: ProviderId, request: ProviderRunRequest): ProviderRunHandle {
    if (this.disabledProviders.has(providerId)) throw new Error(`provider disabled by SCRY_DISABLED_PROVIDERS: ${providerId}`)
    const adapter = this.get(providerId)
    return adapter.run({
      ...request,
      ...(this.runControlsEnabled
        ? { permissionMode: request.permissionMode ?? 'default' }
        : { model: undefined, effort: undefined, permissionMode: 'full_access' }),
      emit: (event) => request.emit({ ...event, providerId, runtimeProvider: adapter.runtimeProvider })
    })
  }

  runControls(context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>> {
    const disabled = this.disabled<AgentRunControlCatalog>(context)
    if (disabled) return disabled
    if (!this.runControlsEnabled) {
      return Promise.resolve({
        ...capabilityReady(context, 'read', {
          models: [],
          permissions: [{
            id: 'full_access' as const,
            label: '完全访问',
            description: 'SCRY_RUN_CONTROLS=0，沿用升级前的完全访问行为'
          }]
        }),
        state: 'degraded' as const,
        reason: '运行控制已通过 SCRY_RUN_CONTROLS=0 关闭'
      })
    }
    return this.get(context.providerId).runControls?.read(context) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可用的运行控制接口'))
  }

  async describe(): Promise<ProviderDescriptor[]> {
    return Promise.all([...this.adapters.values()].map(async (adapter) => {
      const descriptor = await adapter.describe()
      return this.disabledProviders.has(adapter.id)
        ? {
            ...descriptor,
            available: false,
            disabledReason: `已通过 SCRY_DISABLED_PROVIDERS 禁用 ${adapter.id}`,
            health: { ...descriptor.health, state: 'unavailable' as const, transport: descriptor.health?.transport ?? descriptor.transport }
          }
        : descriptor
    }))
  }

  listSkills(context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>> {
    return this.disabled<SkillMeta[]>(context) ?? this.get(context.providerId).skills?.list(context) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可用的 Skill 读取接口'))
  }

  setSkillEnabled(context: ProviderContext, name: string, enabled: boolean): Promise<CapabilityEnvelope<boolean>> {
    return this.disabled<boolean>(context) ?? this.get(context.providerId).skills?.setEnabled?.(context, name, enabled) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 不支持由 Scry 管理 Skill 开关'))
  }

  mcpSnapshot(
    context: ProviderContext,
    refresh = false,
    execution?: AuthorizedMcpExecution
  ): Promise<CapabilityEnvelope<McpSnapshot>> {
    return this.disabled<McpSnapshot>(context) ?? this.get(context.providerId).mcp?.snapshot(context, refresh, execution) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可用的 MCP 状态接口'))
  }

  setMcpEnabled(context: ProviderContext, name: string, enabled: boolean): Promise<CapabilityEnvelope<boolean>> {
    return this.disabled<boolean>(context) ?? this.get(context.providerId).mcp?.setEnabled?.(context, name, enabled) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 不支持由 Scry 管理 MCP 开关'))
  }

  testMcp(
    context: ProviderContext,
    name: string,
    execution?: AuthorizedMcpExecution
  ): Promise<CapabilityEnvelope<McpTestResult>> {
    return this.disabled<McpTestResult>(context) ?? this.get(context.providerId).mcp?.test?.(context, name, execution) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 不支持由 Scry 直接测试 MCP 工具'))
  }

  reauthenticateMcp(
    context: ProviderContext,
    targetId: string,
    execution: AuthorizedMcpExecution | undefined,
    interaction: McpAuthInteraction
  ): Promise<CapabilityEnvelope<McpAuthResult>> {
    return this.disabled<McpAuthResult>(context) ??
      this.get(context.providerId).mcp?.reauthenticate?.(context, targetId, execution, interaction) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 不支持由 Scry 发起 MCP 认证'))
  }

  listCommands(context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>> {
    return this.disabled<ProviderCommand[]>(context) ?? this.get(context.providerId).commands?.list(context) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可嵌入的命令目录'))
  }

  account(context: ProviderContext): Promise<CapabilityEnvelope<AccountSnapshot>> {
    return this.disabled<AccountSnapshot>(context) ?? this.get(context.providerId).account?.read(context) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可用的账户用量接口'))
  }

  inspectHookTrust(context: ProviderContext): Promise<CodexHookInspection> {
    const facet = this.get(context.providerId).hookTrust
    if (!facet) throw new Error(`provider does not expose Hook trust state: ${context.providerId}`)
    return facet.inspect(context)
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.dispose?.()))
  }
}

export function parseDisabledProviders(value: string | undefined): ReadonlySet<ProviderId> {
  const known = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode'])
  return new Set(
    (value?.split(',') ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter((item): item is ProviderId => known.has(item as ProviderId))
  )
}
