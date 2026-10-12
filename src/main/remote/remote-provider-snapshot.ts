import type { CapabilityEnvelope } from '../../shared/provider'
import type { AgentPermissionMode, AgentRunControlCatalog } from '../../shared/runtime'
import type { RemoteProviderRef } from './remote-gateway'

// One phone picker entry for one available Provider context (Pi profiles are
// separate contexts). Pure so the probe-failure rule below is testable.
export function remoteProviderEntry(input: {
  descriptor: { id: string; label: string }
  profile?: { id: string; label: string }
  controls: CapabilityEnvelope<AgentRunControlCatalog>
  // The previously published snapshot, for the probe-failure rule.
  previous: readonly RemoteProviderRef[]
  // Owner-set SCRY_REMOTE_PERMISSION_MODE override.
  permissionOverride?: AgentPermissionMode
}): RemoteProviderRef {
  const { descriptor, profile, controls, permissionOverride } = input
  const label = profile ? `${descriptor.label} · ${profile.label}` : descriptor.label
  if (controls.state === 'unknown') {
    // A failed probe is not "this Provider has no controls" (`unsupported`).
    // Publishing it without permissions would make the phone fall back to
    // `default`, which e.g. Pi rejects at run start. Keep the last good entry
    // for this context, or hide it until a probe succeeds.
    const previous = input.previous.find((entry) =>
      entry.available && entry.id === descriptor.id && entry.agentProfileId === profile?.id)
    return previous ?? { id: descriptor.id, label, available: false, ...(profile ? { agentProfileId: profile.id } : {}) }
  }
  const models = controls.data?.models.map((option) => ({
    id: option.model.id,
    ...(option.model.providerId ? { providerId: option.model.providerId } : {}),
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.isDefault ? { isDefault: true } : {}),
    ...(option.efforts.length ? { efforts: option.efforts } : {})
  })) ?? []
  const model = controls.data?.models.find((option) => option.isDefault) ?? controls.data?.models[0]
  const advertisedPermissions = permissionOverride
    ? controls.data?.permissions.filter((option) => option.id === permissionOverride)
    : controls.data?.permissions
  return {
    id: descriptor.id,
    label,
    available: true,
    ...(profile ? { agentProfileId: profile.id } : {}),
    ...(model?.model.id ? { modelId: model.model.id } : {}),
    ...(models.length ? { models } : {}),
    ...(model?.efforts.length ? { efforts: model.efforts } : {}),
    ...(controls.data?.permissions.length || permissionOverride ? {
      // An owner-set override is authoritative. Advertise only the mode
      // that will really execute so the phone renders it as locked rather
      // than offering choices that the Mac would silently ignore.
      permissions: (advertisedPermissions?.length ? advertisedPermissions : [{
        id: permissionOverride ?? 'default',
        label: permissionOverride === 'full_access' ? '完全访问' : permissionOverride === 'auto_review' ? '自动审查' : '默认审批'
      }]).map((option) => ({
        ...option,
        ...(permissionOverride ? { isDefault: true } : option.id === 'default' ? { isDefault: true } : {})
      }))
    } : {})
  }
}
