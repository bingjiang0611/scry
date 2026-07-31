import type { BillingProvider } from '../../shared/billing'
import { capabilityReady, type ProviderId } from '../../shared/provider'
import type { RuntimeProvider } from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'
import { assertRuntimeCliSurface, runCliAgent } from '../cli-runtime'
import { resolveRuntimeCliBin, runtimeCliEnv } from '../claude-locate'
import type { ProviderAdapter, ProviderRunRequest } from './types'
import { permissionOptions } from './run-controls'

type LegacyProviderId = Extract<ProviderId, 'codex' | 'qoder'>

function runtimeFor(providerId: LegacyProviderId): Exclude<RuntimeProvider, 'claude_sdk' | 'opencode_server'> {
  return providerId === 'codex' ? 'codex_cli' : 'qoder_cli'
}

function billingFor(providerId: LegacyProviderId): BillingProvider {
  return providerId === 'codex' ? 'codex' : 'qoder'
}

function legacyPermissionOptions(providerId: LegacyProviderId) {
  const options = permissionOptions()
  if (providerId === 'qoder') return options
  return options
    .filter((option) => option.id !== 'auto_review')
    .map((option) => option.id === 'default'
      ? {
          ...option,
          label: '工作区沙箱',
          description: 'legacy codex exec 在 workspace-write 沙箱内非交互运行；越界请求不会自动升级'
        }
      : option)
}

function legacyTrace(providerId: LegacyProviderId, event: TraceEvent): TraceEvent {
  const qoderResult = providerId === 'qoder' && event.kind === 'harness' && event.stage === 'result'
  return {
    ...event,
    costUsd: qoderResult ? undefined : event.costUsd,
    costSource: qoderResult ? undefined : event.costSource,
    costConfidence: qoderResult ? undefined : event.costConfidence,
    costUnit: qoderResult ? undefined : event.costUnit,
    modelUsage: event.modelUsage?.map((usage) => ({
      ...usage,
      costUsd: qoderResult ? undefined : usage.costUsd,
      costSource: qoderResult ? undefined : usage.costSource,
      costConfidence: qoderResult ? undefined : usage.costConfidence,
      costUnit: qoderResult ? undefined : usage.costUnit,
      billingProvider: billingFor(providerId),
      upstreamProvider: providerId,
      usageSource: 'legacy_cli'
    })),
    billingProvider: billingFor(providerId),
    upstreamProvider: providerId,
    usageSource: 'legacy_cli',
    runtimeMetadata: { ...(event.runtimeMetadata ?? {}), transport: 'legacy-cli-jsonl', degraded: true }
  }
}

export function createLegacyCliAdapter(providerId: LegacyProviderId, nativeAdapter?: ProviderAdapter): ProviderAdapter {
  const runtimeProvider = runtimeFor(providerId)
  const executable = (): string | undefined => resolveRuntimeCliBin(providerId)
  return {
    id: providerId,
    runtimeProvider,
    describe: async () => {
      const path = executable()
      return {
        id: providerId,
        label: providerId === 'codex' ? 'Codex' : 'Qoder',
        runtimeProvider,
        transport: 'legacy-cli-jsonl',
        available: !!path,
        path,
        disabledReason: path ? '显式启用兼容 transport；仅保留运行能力，不提供 Skill/MCP/命令/账户管理' : undefined,
        capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
        health: {
          state: path ? 'degraded' : 'unavailable',
          transport: 'legacy-cli-jsonl',
          lastError: path ? '显式兼容模式：原生 Provider API 已停用' : `${providerId} CLI 未找到`
        }
      }
    },
    run: (request: ProviderRunRequest) => {
      if (providerId === 'codex' && request.permissionMode === 'auto_review') {
        throw new Error('codex legacy transport 不支持 auto_review；请选择工作区沙箱、完全访问或切回 native transport')
      }
      if (request.resume) {
        throw new Error(`${providerId} legacy transport 不支持恢复已有会话；请新建对话或切回 native transport`)
      }
      const path = executable()
      if (!path) throw new Error(`${providerId} CLI 未找到`)
      const options = {
        runtimeProvider,
        executablePath: path,
        cwd: request.cwd,
        env: runtimeCliEnv(),
        timeoutMs: 30 * 60_000,
        permissionMode: request.permissionMode,
        bypassHookTrust: request.bypassHookTrust,
        ...(providerId === 'qoder' ? { mcpConfigPath: '{"mcpServers":{}}' } : {}),
        ...(providerId === 'codex'
          ? { configArgs: ['--ignore-user-config', '-c', 'mcp_servers={}'] }
          : {}),
        onSessionId: request.onExternalSessionId,
        capabilityMetadata: { transport: 'legacy-cli-jsonl', degraded: true, resumeSupported: false }
      } as const
      assertRuntimeCliSurface(options)
      const handle = runCliAgent(request.prompt, request.runId, (event) => request.emit(legacyTrace(providerId, event)), options)
      return {
        promise: handle.promise.then((result) => ({
          externalSessionId: result.sessionId,
          stopped: result.stopped,
          mcp: result.mcpStatus ? { configured: [], runtime: result.mcpStatus } : undefined
        })),
        interrupt: handle.interrupt,
        getExternalSessionId: handle.getSessionId
      }
    },
    runControls: {
      read: async (context) => capabilityReady(context, 'read', { models: [], permissions: legacyPermissionOptions(providerId) })
    },
    ...(providerId === 'codex' && nativeAdapter?.hookTrust ? { hookTrust: nativeAdapter.hookTrust } : {})
  }
}

export function selectProviderTransports(
  nativeAdapters: ProviderAdapter[],
  spec: string | undefined,
  warn: (message: string) => void = console.warn
): ProviderAdapter[] {
  const overrides = new Map<string, string>()
  for (const raw of spec?.split(',') ?? []) {
    const [providerId, transport] = raw.split(':').map((part) => part.trim().toLowerCase())
    if (!providerId) continue
    overrides.set(providerId, transport)
  }
  return nativeAdapters.map((adapter) => {
    const transport = overrides.get(adapter.id)
    if (!transport || transport === 'native') return adapter
    if (transport === 'legacy' && (adapter.id === 'codex' || adapter.id === 'qoder')) {
      return createLegacyCliAdapter(adapter.id, adapter)
    }
    warn(`忽略无效 SCRY_PROVIDER_TRANSPORTS 项：${adapter.id}:${transport}`)
    return adapter
  })
}
