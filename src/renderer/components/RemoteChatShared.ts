import type { AgentPermissionMode, AgentRunControlCatalog, AgentRunControls } from '@shared/runtime'
import type { DesktopRemoteContext, DesktopRemoteIntent, RemoteProviderRef } from '@shared/desktop-remote'
import { REMOTE_SESSION_COPY } from '../constants/copy'

export const POLL_MS = 1500
export const QUIET_POLL_MAX_MS = 5000

export function keepIfEqual<T>(next: T): (current: T) => T {
  return (current) => current === next || JSON.stringify(current) === JSON.stringify(next) ? current : next
}

export function intentMatches(intent: DesktopRemoteIntent, context: DesktopRemoteContext): boolean {
  return intent.context.cwd === context.cwd && intent.context.providerId === context.providerId &&
    (intent.context.agentProfileId ?? '') === (context.agentProfileId ?? '') && (intent.context.externalSessionId ?? '') === (context.externalSessionId ?? '')
}

export function remoteDraftKey(connectionId: string, cwd: string, externalSessionId?: string): string {
  return JSON.stringify(['remote', connectionId, cwd, externalSessionId ?? 'new'])
}

export function remoteAgentId(provider: Pick<RemoteProviderRef, 'id' | 'agentProfileId'>): string {
  return provider.agentProfileId ? `${provider.id}:${provider.agentProfileId}` : provider.id
}

export function remotePermissionOption(option: { id: string; label: string; description?: string }, host: string): AgentRunControlCatalog['permissions'][number] {
  const label = option.label.replace(/^本机/, '')
  return {
    id: option.id as AgentPermissionMode,
    label: `${label} · ${host}`,
    description: option.id === 'full_access'
      ? `跳过审批；Agent 以 ${host} 上的用户权限运行`
      : option.description ?? `在 ${host} 上运行`
  }
}

export function remoteRunControlCatalog(provider: RemoteProviderRef | undefined, host: string): AgentRunControlCatalog {
  if (!provider) return { models: [], permissions: [] }
  return {
    models: (provider.models ?? []).map((model) => ({
      model: { id: model.id, ...(model.providerId ? { providerId: model.providerId } : {}) },
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault ? { isDefault: true } : {}),
      efforts: model.efforts ?? provider.efforts ?? []
    })),
    permissions: (provider.permissions ?? []).map((option) => remotePermissionOption(option, host))
  }
}

export function remoteControlsValid(provider: RemoteProviderRef | undefined, controls: AgentRunControls): boolean {
  if (!provider?.available) return false
  const model = controls.model
    ? provider.models?.find((option) => option.id === controls.model?.id && option.providerId === controls.model?.providerId)
    : provider.models?.find((option) => option.id === provider.modelId || option.isDefault)
  if (controls.model && !model) return false
  if (controls.effort && !(model?.efforts ?? provider.efforts ?? []).some((option) => option.id === controls.effort)) return false
  return provider.permissions?.length
    ? provider.permissions.some((option) => option.id === controls.permissionMode)
    : controls.permissionMode === 'default'
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('desktop_session_operation_unknown') ? REMOTE_SESSION_COPY.operationUnknown : message
}
