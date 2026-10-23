import type { RemoteProviderRef } from '@shared/desktop-remote'
import type { AgentPermissionMode, AgentRunControls } from '@shared/runtime'
import { parseStoredRunControls } from './hooks/useIntegrations'

const defaultOption = (options: readonly { id: string; isDefault?: boolean }[] | undefined): string | undefined =>
  options?.find(option => option.isDefault)?.id ?? options?.[0]?.id

export function readRemoteProviderKey(connectionId: string): string | null {
  try {
    return window.localStorage.getItem(`scry:remote-provider:v1:${connectionId}`)
  } catch {
    return null
  }
}

export function writeRemoteProviderKey(connectionId: string, key: string): void {
  try {
    window.localStorage.setItem(`scry:remote-provider:v1:${connectionId}`, key)
  } catch {
    // A denied storage write does not invalidate the current Provider choice.
  }
}

// Host + Provider/profile owns the preference, not the current project/session.
export function remoteRunControlsKey(connectionId: string, provider: Pick<RemoteProviderRef, 'id' | 'agentProfileId'>): string {
  return `scry:remote-run-controls:v1:${JSON.stringify([connectionId, provider.id, provider.agentProfileId ?? ''])}`
}

export function readRemoteRunControls(key: string): AgentRunControls | undefined {
  try {
    return parseStoredRunControls(JSON.parse(window.localStorage.getItem(key) ?? 'null'))
  } catch {
    return undefined
  }
}

export function writeRemoteRunControls(key: string, controls: AgentRunControls): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(controls))
  } catch {
    // A storage failure must not prevent this window from using its selection.
  }
}

export function initialRemoteRunControls(provider: RemoteProviderRef, saved?: AgentRunControls): AgentRunControls {
  const model = provider.models?.find(option => option.id === saved?.model?.id && option.providerId === saved.model.providerId) ??
    provider.models?.find(option => option.id === provider.modelId) ??
    provider.models?.find(option => option.isDefault) ?? provider.models?.[0]
  const efforts = model?.efforts ?? provider.efforts
  return {
    ...(model ? { model: { id: model.id, ...(model.providerId ? { providerId: model.providerId } : {}) } } : {}),
    effort: efforts?.some(option => option.id === saved?.effort) ? saved?.effort : defaultOption(efforts),
    permissionMode: (provider.permissions?.some(option => option.id === saved?.permissionMode)
      ? saved!.permissionMode : defaultOption(provider.permissions) ?? 'default') as AgentPermissionMode
  }
}
