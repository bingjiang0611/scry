import type { DesktopDirectoryResult, DesktopHostReadResult } from '../../shared/desktop-remote'
import { parseDesktopDirectoryQuery } from './desktop-directory-picker'
import { parseDesktopHostRead } from './desktop-host-reader'
import { parseDesktopWorkbenchQuery } from './desktop-workbench'
import { attachmentCapability, type DesktopAttachmentStore } from './desktop-attachments'
import type { HostControllerDependencies } from './host-controller-types'

// Device-facing desktop reads: the history/trace/workbench surface, and the host
// directory picker the device may browse. Each read re-checks the device grant
// before it returns, so a revocation during a long read is not reported as a
// success. Capabilities reported in `info` are the ones this host can actually
// serve; a missing reader is unavailable, never an empty success.
export interface DesktopReadDeps {
  authorizeDevice(peer: string): void
  readDesktop?: HostControllerDependencies['readDesktop']
  desktopWorkbench?: HostControllerDependencies['desktopWorkbench']
  desktopDirectories?: HostControllerDependencies['desktopDirectories']
  providerControls: boolean
  attachmentStore?: DesktopAttachmentStore
  canSessionActions: boolean
  canSessionFork: boolean
  canSessionDelete: boolean
}

export async function readDesktop(deps: DesktopReadDeps, peerCertSHA256: string, input: unknown): Promise<DesktopHostReadResult> {
  deps.authorizeDevice(peerCertSHA256)
  if (!deps.readDesktop) throw new Error('desktop_protocol_unavailable')
  const result = await deps.readDesktop(parseDesktopHostRead(input))
  deps.authorizeDevice(peerCertSHA256)
  if (result.kind !== 'info') return result
  const { sessionActions: _reportedSessionActions, sessionFork: _reportedSessionFork, sessionDelete: _reportedSessionDelete, ...info } = result
  return {
    ...info,
    ...(deps.providerControls ? { providerDiscovery: 2 as const } : {}),
    ...(deps.desktopDirectories ? { directorySelection: true as const } : {}),
    ...(deps.desktopWorkbench ? {
      workbench: 1 as const,
      ...(!deps.desktopWorkbench.operations.openPath || !deps.desktopWorkbench.operations.trashItem
        ? { workbenchOps: deps.desktopWorkbench.operations }
        : {})
    } : {}),
    ...(deps.canSessionActions ? { sessionActions: true as const } : {}),
    ...(deps.canSessionFork ? { sessionFork: true as const } : {}),
    ...(deps.canSessionDelete ? { sessionDelete: true as const } : {}),
    ...(deps.attachmentStore ? { attachments: attachmentCapability() } : {})
  }
}

export async function readDesktopWorkbench(deps: DesktopReadDeps, peer: string, input: unknown): Promise<unknown> {
  deps.authorizeDevice(peer)
  if (!deps.desktopWorkbench) throw new Error('desktop_workbench_unavailable')
  const result = await deps.desktopWorkbench.request(peer, parseDesktopWorkbenchQuery(input), () => deps.authorizeDevice(peer))
  try { deps.authorizeDevice(peer) } catch (error) {
    await deps.desktopWorkbench.release(peer)
    throw error
  }
  return result
}

export function readDesktopDirectory(deps: DesktopReadDeps, peerCertSHA256: string, input: unknown): DesktopDirectoryResult {
  deps.authorizeDevice(peerCertSHA256)
  if (!deps.desktopDirectories) throw new Error('desktop_directory_selection_unavailable')
  const query = parseDesktopDirectoryQuery(input)
  return query.action === 'list'
    ? { action: 'list', page: deps.desktopDirectories.list(query) }
    : { action: 'select', project: deps.desktopDirectories.select(query.path) }
}
