import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { McpSnapshot, ProviderContext } from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import { isRemoteMcpConfig } from '../mcp-config'
import { effortOption, permissionOptions } from './run-controls'
import { unwrap } from './opencode-errors'
import { record } from './opencode-records'
import type { AuthorizedMcpExecution } from './types'

export function openCodeModelContextWindows(data: unknown[]): Map<string, number> {
  const windows = new Map<string, number>()
  for (const raw of data) {
    const model = record(raw)
    const limit = record(model.limit)
    const contextWindow = typeof limit.context === 'number' && Number.isFinite(limit.context) && limit.context > 0
      ? limit.context
      : undefined
    if (contextWindow && typeof model.id === 'string' && typeof model.providerID === 'string') {
      windows.set(`${model.providerID}\0${model.id}`, contextWindow)
    }
  }
  return windows
}

export function openCodeRunControlCatalog(data: unknown[]): AgentRunControlCatalog {
  return {
    models: data.map((raw) => {
      const model = record(raw)
      const efforts = Array.isArray(model.variants)
        ? model.variants
            .map((variant) => record(variant))
            .filter((variant) => typeof variant.id === 'string')
            .map((variant) => effortOption(String(variant.id), undefined, variant.id === record(model.request).variant))
        : []
      return {
        model: {
          id: String(model.id ?? ''),
          providerId: String(model.providerID ?? '')
        },
        label: `${String(model.name ?? model.id ?? '')} · ${String(model.providerID ?? '')}`,
        efforts
      }
    }).filter((model) => model.model.id && model.model.providerId),
    permissions: permissionOptions()
  }
}

export async function openCodeMcpSnapshot(
  client: OpencodeClient,
  context: ProviderContext,
  configured: McpSnapshot['configured'],
  authenticate: string[]
): Promise<McpSnapshot> {
  const statuses = await unwrap<Record<string, { status?: string; error?: string }>>(
    client.mcp.status({ directory: context.cwd }),
    'mcp.status'
  )
  return {
    configured,
    runtime: Object.entries(statuses).map(([name, status]) => ({
      name,
      status:
        status.status === 'needs_auth'
          ? 'needs-auth'
          : status.status === 'needs_client_registration'
            ? 'needs-client-registration'
          : status.status === 'connected'
            ? 'connected'
            : status.status === 'disabled'
              ? 'disabled'
              : 'failed'
    })),
    operations: { authenticate }
  }
}

export function openCodeAuthenticationTargets(execution: AuthorizedMcpExecution | undefined): string[] {
  if (!execution) return []
  const nameCounts = new Map<string, number>()
  for (const target of execution.targets) {
    if (target.enabled) nameCounts.set(target.name, (nameCounts.get(target.name) ?? 0) + 1)
  }
  return execution.targets
    .filter((target) =>
      target.enabled
      && nameCounts.get(target.name) === 1
      && isRemoteMcpConfig(target.config)
      && target.config.oauth !== false
    )
    .map((target) => target.targetId)
}
