import {
  capabilityReady,
  capabilityUnavailable,
  type CapabilityEnvelope,
  type McpAuthResult,
  type McpSnapshot,
  type McpTestResult,
  type ProviderCommand,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderId,
  type SkillMeta,
  unavailableProviderDescriptor
} from '../../shared/provider'
import type { ProviderCompatibilityAdvisory } from '../../shared/provider-compatibility'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import type { ParsedTurn } from '../normalize'
import { enrichPiHistoryCredits } from '../pi-credit-projection'
import type {
  AuthorizedMcpExecution,
  McpAuthInteraction,
  ProviderAdapter,
  ProviderRunHandle,
  ProviderRunRequest
} from './types'
import type { CodexHookInspection } from '../codex-hook-trust'
import { PerformanceTrace, performanceRecordingEnabled } from '../performance-timing'

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>()
  private readonly disabledProviders: ReadonlySet<ProviderId>
  private readonly runControlsEnabled: boolean

  private readonly compatibility?: (providerId: ProviderId, version: string | undefined) => ProviderCompatibilityAdvisory

  constructor(
    adapters: ProviderAdapter[],
    options: {
      disabledProviders?: ReadonlySet<ProviderId>
      runControlsEnabled?: boolean
      /** 版本兼容性建议源；缺省表示不附带建议。 */
      compatibility?: (providerId: ProviderId, version: string | undefined) => ProviderCompatibilityAdvisory
    } = {}
  ) {
    this.disabledProviders = options.disabledProviders ?? new Set()
    this.runControlsEnabled = options.runControlsEnabled ?? true
    if (options.compatibility) this.compatibility = options.compatibility
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

  async continuationKey(context: ProviderContext): Promise<string> {
    if (this.disabledProviders.has(context.providerId)) throw new Error(`provider disabled by SCRY_DISABLED_PROVIDERS: ${context.providerId}`)
    const adapter = this.get(context.providerId)
    if (!adapter.continuationKey) throw new Error(`${context.providerId} 尚未提供可验证的接续身份`)
    const key = await adapter.continuationKey(context)
    if (typeof key !== 'string' || key.length === 0) throw new Error(`${context.providerId} 返回了无效的接续身份`)
    return key
  }

  run(providerId: ProviderId, request: ProviderRunRequest): ProviderRunHandle {
    if (this.disabledProviders.has(providerId)) throw new Error(`provider disabled by SCRY_DISABLED_PROVIDERS: ${providerId}`)
    const adapter = this.get(providerId)
    if ((request.historicalContext || request.trackInputReceipt || request.expectedInputTextHash) && !adapter.historicalContext) {
      throw new Error(`${providerId} 尚未提供可验证的历史输入交接`)
    }
    if (request.historyReader && !adapter.historyReader) throw new Error(`${providerId} 尚未提供可验证的历史检索工具`)
    return adapter.run({
      ...request,
      ...(this.runControlsEnabled
        ? { permissionMode: request.permissionMode ?? 'default' }
        : { model: undefined, effort: undefined, permissionMode: 'default' }),
      emit: (event) => request.emit({ ...event, providerId, runtimeProvider: adapter.runtimeProvider })
    })
  }

  async enrichSession(context: ProviderContext, turns: ParsedTurn[]): Promise<ParsedTurn[]> {
    // Offline evidence remains readable when execution is disabled. This runs after
    // native/archive reconciliation; it never launches or probes a Provider.
    if (context.providerId === 'pi' && context.cwd && context.externalSessionId) {
      turns = await enrichPiHistoryCredits(turns, { cwd: context.cwd, sessionId: context.externalSessionId })
    }
    if (this.disabledProviders.has(context.providerId)) return turns
    return this.get(context.providerId).sessionEvidence?.enrich(context, turns) ?? Promise.resolve(turns)
  }

  private measureCatalog<T>(
    facet: 'commands' | 'run_controls' | 'skills',
    context: ProviderContext,
    read: () => Promise<CapabilityEnvelope<T>>
  ): Promise<CapabilityEnvelope<T>> {
    if (!performanceRecordingEnabled()) return read()
    const trace = new PerformanceTrace(`provider.catalog.${facet}`, { provider: context.providerId })
    try {
      return read().then(result => {
        trace.finish(undefined, result.state === 'unknown' || result.state === 'unsupported' ? 'unavailable' : 'completed')
        return result
      }, (error: unknown) => {
        trace.finish(undefined, 'error')
        throw error
      })
    } catch (error) {
      trace.finish(undefined, 'error')
      throw error
    }
  }

  runControls(context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>> {
    return this.measureCatalog('run_controls', context, () => this.readRunControls(context))
  }

  private readRunControls(context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>> {
    const disabled = this.disabled<AgentRunControlCatalog>(context)
    if (disabled) return disabled
    if (!this.runControlsEnabled) {
      return Promise.resolve({
        ...capabilityReady(context, 'read', {
          models: [],
          permissions: [{
            id: 'default' as const,
            label: '默认审批',
            description: '运行控制已关闭；权限保持 Provider 默认安全模式'
          }]
        }),
        state: 'degraded' as const,
        reason: '运行控制已通过 SCRY_RUN_CONTROLS=0 关闭'
      })
    }
    return this.get(context.providerId).runControls?.read(context) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可用的运行控制接口'))
  }

  /**
   * 描述全部已注册 Provider。单个 adapter 的 describe 失败只能让**它自己**降为
   * unavailable 影子快照；以前一个异常会让整个 Provider 列表报错，用户看到的是
   * 「一个 Provider 都没有」，这比少一个 Provider 更容易被误读。
   */
  async describe(): Promise<ProviderDescriptor[]> {
    return Promise.all([...this.adapters.values()].map(async (adapter) => {
      let descriptor: ProviderDescriptor
      try {
        descriptor = await adapter.describe()
      } catch (error) {
        descriptor = unavailableProviderDescriptor({
          id: adapter.id,
          runtimeProvider: adapter.runtimeProvider,
          reason: `Provider 描述失败：${error instanceof Error ? error.message : String(error)}`
        })
      }
      const described = this.disabledProviders.has(adapter.id)
        ? {
            ...descriptor,
            available: false,
            disabledReason: `已通过 SCRY_DISABLED_PROVIDERS 禁用 ${adapter.id}`,
            health: { ...descriptor.health, state: 'unavailable' as const, transport: descriptor.health?.transport ?? descriptor.transport }
          }
        : descriptor
      const advisory = this.compatibility?.(adapter.id, described.version)
      return advisory ? { ...described, compatibility: advisory } : described
    }))
  }

  /**
   * 已配置但未注册的 Provider 的影子快照。让调用方能在不抛错的前提下如实说出
   * 「这个 Provider 在本构建里不可用」。
   */
  describeUnavailable(providerId: ProviderId, reason: string): ProviderDescriptor {
    return unavailableProviderDescriptor({ id: providerId, reason })
  }

  isRegistered(providerId: ProviderId): boolean {
    return this.adapters.has(providerId)
  }

  listSkills(context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>> {
    return this.measureCatalog('skills', context, () =>
      this.disabled<SkillMeta[]>(context) ?? this.get(context.providerId).skills?.list(context) ??
        Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可用的 Skill 读取接口')))
  }

  invalidateContext(context: ProviderContext): Promise<void> | void {
    if (this.disabledProviders.has(context.providerId)) return
    return this.get(context.providerId).invalidateContext?.(context)
  }

  mcpSnapshot(
    context: ProviderContext,
    refresh = false,
    execution?: AuthorizedMcpExecution
  ): Promise<CapabilityEnvelope<McpSnapshot>> {
    return this.disabled<McpSnapshot>(context) ?? this.get(context.providerId).mcp?.snapshot(context, refresh, execution) ??
      Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可用的 MCP 状态接口'))
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
    return this.measureCatalog('commands', context, () =>
      this.disabled<ProviderCommand[]>(context) ?? this.get(context.providerId).commands?.list(context) ??
        Promise.resolve(capabilityUnavailable(context, 'unsupported', '该 Provider 没有可嵌入的命令目录')))
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
  const known = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi'])
  return new Set(
    (value?.split(',') ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter((item): item is ProviderId => known.has(item as ProviderId))
  )
}
