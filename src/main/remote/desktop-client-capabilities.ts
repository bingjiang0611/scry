import { REMOTE_PROTOCOL_VERSION } from '../../shared/desktop-remote'
import type { DesktopAttachmentCapability } from './desktop-attachments'
import { DESKTOP_ATTACHMENT_CHUNK_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES } from './desktop-attachments'
import { fail, record } from './desktop-client-validation'
import { protocolFailure } from './remote-protocol'

// What a host declares it can do, negotiated once from `desktop info`. The
// catalog snapshot reuses this so a device does not read capabilities twice.
/** Host capabilities negotiated by `desktop info`, reused by the catalog snapshot. */
export type DesktopCapabilities = ReturnType<typeof validateInfo>

export function validateInfo(response: unknown, hostId: string): { providerDiscovery?: 2; directorySelection?: true; workbench?: 1; workbenchOps?: { openPath: boolean; trashItem: boolean }; sessionActions?: true; sessionFork?: true; sessionDelete?: true; traceDelta?: 1; attachments?: DesktopAttachmentCapability } {
  if (!record(response) || !record(response.desktop) || response.desktop.kind !== 'info') fail('invalid_desktop_response')
  // The host states its run-channel version in `info`. A missing or different one
  // is a refusal, not a degraded mode; the code names the end that is behind.
  if (response.desktop.protocol !== REMOTE_PROTOCOL_VERSION) fail(protocolFailure(response.desktop.protocol, 'desktop_protocol_missing'))
  if (response.desktop.hostId !== hostId || response.desktop.execution !== 'canonical' ||
      (response.desktop.providerDiscovery !== undefined && response.desktop.providerDiscovery !== 2) ||
      (response.desktop.directorySelection !== undefined && response.desktop.directorySelection !== true) ||
      (response.desktop.workbench !== undefined && response.desktop.workbench !== 1) ||
      (response.desktop.sessionActions !== undefined && response.desktop.sessionActions !== true) ||
      (response.desktop.sessionFork !== undefined && response.desktop.sessionFork !== true) ||
      (response.desktop.sessionDelete !== undefined && response.desktop.sessionDelete !== true) ||
      (response.desktop.traceDelta !== undefined && response.desktop.traceDelta !== 1)) fail('desktop_capability_unavailable')
  const workbenchOps = response.desktop.workbenchOps
  if (workbenchOps !== undefined && (!record(workbenchOps) || typeof workbenchOps.openPath !== 'boolean' || typeof workbenchOps.trashItem !== 'boolean')) fail('desktop_capability_unavailable')
  const attachmentInfo = response.desktop.attachments
  if (attachmentInfo !== undefined && (!record(attachmentInfo) || attachmentInfo.transport !== 'chunked' || attachmentInfo.maxBytes !== DESKTOP_ATTACHMENT_MAX_BYTES || attachmentInfo.maxTotalBytes !== DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES || attachmentInfo.maxCount !== DESKTOP_ATTACHMENT_MAX_COUNT || attachmentInfo.chunkBytes !== DESKTOP_ATTACHMENT_CHUNK_BYTES)) fail('desktop_capability_unavailable')
  return {
    ...(response.desktop.providerDiscovery === 2 ? { providerDiscovery: 2 as const } : {}),
    ...(response.desktop.directorySelection === true ? { directorySelection: true as const } : {}),
    ...(response.desktop.workbench === 1 ? {
      workbench: 1 as const,
      workbenchOps: workbenchOps
        ? { openPath: workbenchOps.openPath as boolean, trashItem: workbenchOps.trashItem as boolean }
        : { openPath: true, trashItem: true }
    } : {}),
    ...(response.desktop.sessionActions === true ? { sessionActions: true as const } : {}),
    ...(response.desktop.sessionFork === true ? { sessionFork: true as const } : {}),
    ...(response.desktop.sessionDelete === true ? { sessionDelete: true as const } : {}),
    ...(response.desktop.traceDelta === 1 ? { traceDelta: 1 as const } : {}),
    ...(attachmentInfo ? { attachments: attachmentInfo as unknown as DesktopAttachmentCapability } : {})
  }
}
