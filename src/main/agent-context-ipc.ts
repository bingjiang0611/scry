import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderContext, ProviderId } from '../shared/provider'
import type { AgentInputAttachment } from '../shared/runtime'
import type { Dialog } from 'electron'
import type { createRecentFoldersStore } from './app-store'
import type { DockBadgeState } from './dock-badge'
import type { ProviderRegistry } from './providers/registry'

/**
 * Agent context and workspace-selection IPC moved verbatim from the main entry
 * module. Selecting a folder still invalidates cached history before it becomes
 * current, a new session still resets the provider context and badge, and a
 * clipboard image is still bounded to one PNG attachment.
 */
export function registerAgentContextIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  providerRegistry: Pick<ProviderRegistry, 'describe' | 'invalidateContext' | 'listSkills' | 'listCommands' | 'runControls'>
  withProviderOperation: <T>(providerId: ProviderId, operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>
  recentStore: () => ReturnType<typeof createRecentFoldersStore>
  dialog: Pick<Dialog, 'showOpenDialog'>
  clipboard: { readImage: () => { isEmpty: () => boolean; getSize: () => { width: number; height: number }; toPNG: () => Buffer } }
  canonicalExistingDirectory: (path: string) => string
  invalidateSessionHistoryLoad: (reason: string) => void
  rememberProject: (cwd: string) => void
  setCurrentCwd: (dir: string | undefined) => void
  currentCwd: () => string | undefined
  resolveKnownProjectDirectory: (cwd: string) => string
  dockBadge: Pick<DockBadgeState, 'view'>
  window: () => { isFocused: () => boolean } | null
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  resetSessionContext: (key: string) => void
}) {
  const { handleTrusted } = deps
  handleTrusted('agent:providerDescriptors', () => deps.providerRegistry.describe())

  handleTrusted('agent:recentFolders', () => deps.recentStore().load())
  handleTrusted('agent:removeRecentFolder', (_event, dir: string) => deps.recentStore().remove(dir))

  handleTrusted('agent:chooseFolder', async () => {
    const r = await deps.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    const dir = deps.canonicalExistingDirectory(r.filePaths[0])
    deps.invalidateSessionHistoryLoad('workspace selection changed')
    deps.rememberProject(dir)
    deps.setCurrentCwd(dir)
    return dir
  })

  handleTrusted('agent:clipboardImage', () => {
    const image = deps.clipboard.readImage()
    if (image.isEmpty()) return null
    const size = image.getSize()
    const bytes = image.toPNG()
    return {
      kind: 'image',
      name: `clipboard-${Date.now().toString(36)}.png`,
      mimeType: 'image/png',
      dataBase64: bytes.toString('base64'),
      size: bytes.byteLength,
      width: size.width,
      height: size.height
    } satisfies AgentInputAttachment
  })

  handleTrusted('agent:setCwd', (_e, dir: string | null) => {
    const cwd = typeof dir === 'string' && dir.trim() ? deps.resolveKnownProjectDirectory(dir) : undefined
    if (cwd !== deps.currentCwd()) deps.invalidateSessionHistoryLoad('workspace changed')
    deps.setCurrentCwd(cwd)
    return cwd ?? null
  })

  handleTrusted('agent:newSession', async (_event, context: ProviderContext) => {
    deps.dockBadge.view(null, Boolean(deps.window()?.isFocused()))
    const cwd = context?.cwd ?? deps.currentCwd()
    if (context?.providerId) {
      const normalizedContext = { ...context, cwd }
      const key = deps.providerContextKey(context.providerId, cwd ?? '', context.agentProfileId)
      deps.resetSessionContext(key)
      await deps.providerRegistry.invalidateContext(normalizedContext)
    }
    return true
  })

  handleTrusted('agent:invalidateProviderContext', async (_event, context: ProviderContext) => {
    const normalizedContext = { ...context, cwd: context.cwd ?? deps.currentCwd() }
    await deps.providerRegistry.invalidateContext(normalizedContext)
    return true
  })
  handleTrusted('agent:listSkills', (_event, context: ProviderContext) =>
    deps.withProviderOperation(context.providerId, () => deps.providerRegistry.listSkills(context), context.agentProfileId)
  )
  handleTrusted('agent:listCommands', (_event, context: ProviderContext) =>
    deps.withProviderOperation(context.providerId, () => deps.providerRegistry.listCommands(context), context.agentProfileId)
  )
  handleTrusted('agent:runControls', (_event, context: ProviderContext) =>
    deps.withProviderOperation(context.providerId, () => deps.providerRegistry.runControls(context), context.agentProfileId)
  )
}
