import { clipboard, dialog, nativeTheme } from 'electron'
import type { BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { AgentInputAttachment } from '../../shared/runtime'
import { writeClipboardText } from '../clipboard-text'
import { isRendererPerformanceSample } from '../../shared/performance'
import { performanceRecordingEnabled } from '../performance-timing'
import { recordRendererPerformance } from '../performance-recording'
import { windowBackgroundColor } from '../window-chrome'
import type { createPiAgentProfileStore, PiAgentProfile } from '../pi-agent-profiles'
import type { DetectedAgent } from '../claude-locate'
import type { ProviderRegistry } from '../providers/registry'
import type { ProviderCompatibilityStore } from '../provider-compatibility-manifest'
import { daemonModeEnabled } from '../daemon-channel-gate'
import { providerDetectionChannelHandlers, registerChannelHandlers } from './startup-channels'
import { addPiProfileFromLauncher, piProfileChannelHandlers, recentFolderChannelHandlers, rememberChosenFolder } from './project-channels'
import { installProjectDaemonWindow } from './project-daemon'

export interface AppAgentBootstrapDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  getWindow: () => BrowserWindow | null
  smokeProviderEnabled: boolean
  smokeDetectedAgents: DetectedAgent[]
  storedPiProfilesNotDetected: (detected: Array<{ id: string }>) => PiAgentProfile[]
  providerCompatibility: ProviderCompatibilityStore
  detectInstalledAgents: () => Promise<DetectedAgent[]>
  providerRegistry: ProviderRegistry
  dialog: typeof dialog
  piProfileStore: () => ReturnType<typeof createPiAgentProfileStore>
  invalidateRemoteProviderMetadata: (providerId: 'pi') => void
  recentStore: () => { load: () => string[]; remove: (cwd: string) => string[] }
  canonicalExistingDirectory: (cwd: string) => string
  invalidateSessionHistoryLoad: (reason: string) => void
  rememberProject: (cwd: string) => void
  setCurrentCwd: (cwd: string | undefined) => void
  resolveKnownProjectDirectory: (cwd: string) => string
  getCurrentCwd: () => string | undefined
}

export function registerAppAgentHandlers(deps: AppAgentBootstrapDependencies): void {
  const { handleTrusted, getWindow, smokeProviderEnabled, smokeDetectedAgents, storedPiProfilesNotDetected, providerCompatibility, detectInstalledAgents, providerRegistry, dialog, piProfileStore, invalidateRemoteProviderMetadata, recentStore, canonicalExistingDirectory, invalidateSessionHistoryLoad, rememberProject, setCurrentCwd, getCurrentCwd } = deps
  handleTrusted('app:setTheme', (_event, theme: unknown) => {
    if (theme !== 'dark' && theme !== 'light') throw new Error('无效的界面主题')
    nativeTheme.themeSource = theme
    getWindow()?.setBackgroundColor(windowBackgroundColor(theme))
    return true as const
  })

  handleTrusted('app:copyText', (_event, text: unknown) => writeClipboardText(text, clipboard))
  handleTrusted('app:performanceDiagnosticsEnabled', () => performanceRecordingEnabled())
  handleTrusted('app:reportRendererPerformance', (_event, sample: unknown) => {
    if (!isRendererPerformanceSample(sample)) throw new Error('无效的 renderer 性能样本')
    if (!performanceRecordingEnabled()) return false
    recordRendererPerformance(sample)
    return true
  })

  registerChannelHandlers(handleTrusted, providerDetectionChannelHandlers({
    smokeProviderEnabled, smokeDetectedAgents, storedPiProfilesNotDetected, providerCompatibility, detectInstalledAgents, providerRegistry
  }))

  // The pickers and dialogs are this window's; the work after them is shared with the
  // daemon (project-channels.ts). In daemon mode the daemon does that work and the App
  // keeps only the window parts (project-daemon.ts).
  const pickFolder = async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  }
  const pickPiLauncher = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ title: '选择 Pi Agent 启动器', properties: ['openFile'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }
  const notifyPiFailure = async (detail: string): Promise<void> => {
    const options = { type: 'error' as const, title: '无法添加 Pi Agent', message: '所选启动器未通过 Pi RPC 握手', detail }
    if (getWindow() && !getWindow()!.isDestroyed()) await dialog.showMessageBox(getWindow()!, options)
    else await dialog.showMessageBox(options)
  }
  if (daemonModeEnabled()) {
    installProjectDaemonWindow({
      pickFolder, pickPiLauncher, notifyPiFailure, windowCwd: getCurrentCwd,
      applyChosenFolder: (dir) => {
        invalidateSessionHistoryLoad('workspace selection changed')
        setCurrentCwd(dir)
      }
    })
  }

  handleTrusted('agent:addPiProfile', async () => {
    const launcher = await pickPiLauncher()
    if (launcher === null) return null
    try {
      return await addPiProfileFromLauncher({ piProfileStore, providerRegistry, invalidateRemoteProviderMetadata }, launcher, getCurrentCwd())
    } catch (error) {
      await notifyPiFailure(String((error as Error).message))
      return null
    }
  })

  registerChannelHandlers(handleTrusted, piProfileChannelHandlers({ piProfileStore, invalidateRemoteProviderMetadata }))
  registerChannelHandlers(handleTrusted, recentFolderChannelHandlers({ recentStore }))

  handleTrusted('agent:chooseFolder', async () => {
    const picked = await pickFolder()
    if (picked === null) return null
    const dir = rememberChosenFolder({ canonicalExistingDirectory, invalidateSessionHistoryLoad, rememberProject }, picked)
    setCurrentCwd(dir)
    return dir
  })

  handleTrusted('agent:clipboardImage', () => {
    const image = clipboard.readImage()
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


}
