import { clipboard, dialog, nativeTheme } from 'electron'
import type { BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { basename } from 'node:path'
import type { AgentInputAttachment } from '../../shared/runtime'
import { writeClipboardText } from '../clipboard-text'
import { isRendererPerformanceSample } from '../../shared/performance'
import { performanceRecordingEnabled } from '../performance-timing'
import { recordRendererPerformance } from '../performance-recording'
import { windowBackgroundColor } from '../window-chrome'
import { canonicalizePiAgentPaths, piProfileForExecutable, createPiAgentProfileStore, type PiAgentProfile } from '../pi-agent-profiles'
import { detectAgentsFast, probeCliVersion, PI_VERSION_PROBE_TIMEOUT_MS, type DetectedAgent } from '../claude-locate'
import { providerIdForAgentId } from '../../shared/runtime'
import { piRpcEnvironment, probePiAgent } from '../providers/pi'
import type { ProviderRegistry } from '../providers/registry'
import type { ProviderCompatibilityStore } from '../provider-compatibility-manifest'
import { composeProviderDetectionResults } from '../provider-detection'

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
  recentStore: () => { load: () => string[]; remove: (cwd: string) => void }
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

  handleTrusted('agent:detectFast', async () => {
    if (smokeProviderEnabled) return smokeDetectedAgents
    const detected = (await canonicalizePiAgentPaths(detectAgentsFast())).flatMap((agent) => {
      const providerId = providerIdForAgentId(agent.id)
      if (!providerId) return []
      return [{
        ...agent,
        ...(providerId === 'pi'
          ? { agentProfileId: agent.id, runtimeProvider: 'pi_rpc' as const, transport: 'JSONL RPC subprocess' }
          : {})
      }]
    })
    return [
      ...detected,
      ...storedPiProfilesNotDetected(detected).map((profile) => ({
        id: profile.id,
        name: profile.label,
        bin: basename(profile.executable),
        path: profile.executable,
        agentProfileId: profile.id,
        runtimeProvider: 'pi_rpc' as const,
        transport: 'JSONL RPC subprocess'
      }))
    ]
  })

  handleTrusted('agent:detect', async () => {
    // 让这次描述用上最新策略；hydrate/refresh 自己吞掉所有失败，不会阻断探测。
    await providerCompatibility.hydrate()
    await providerCompatibility.refresh()
    // 先异步完成 PATH/版本探测，让 descriptor 的同步 fallback 命中已知路径，避免阻塞主进程。
    // Capability disabling alone does not disable discovery's real --version subprocesses.
    const detected = smokeProviderEnabled ? smokeDetectedAgents : await detectInstalledAgents()
    const descriptors = await providerRegistry.describe()
    return composeProviderDetectionResults({
      detected,
      descriptors,
      storedPiProfiles: smokeProviderEnabled ? [] : storedPiProfilesNotDetected(detected),
      probeStoredPiProfile: async (profile) => probeCliVersion(profile.executable, ['--version'], {
        env: await piRpcEnvironment(profile),
        timeout: PI_VERSION_PROBE_TIMEOUT_MS
      }),
      // adapter 自述的版本经常是空，本机真实版本来自 CLI 探测；用最终生效的版本重算判定。
      compatibility: (providerId, version) => providerCompatibility.advisory(providerId, version)
    })
  })

  handleTrusted('agent:addPiProfile', async () => {
    const result = await dialog.showOpenDialog({ title: '选择 Pi Agent 启动器', properties: ['openFile'] })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      const profile = piProfileForExecutable(result.filePaths[0])
      const versionProbe = await probeCliVersion(profile.executable, ['--version'], {
        env: await piRpcEnvironment(profile),
        timeout: PI_VERSION_PROBE_TIMEOUT_MS
      })
      await probePiAgent(profile, getCurrentCwd())
      const stored = piProfileStore().add(profile)
      invalidateRemoteProviderMetadata('pi')
      const descriptor = (await providerRegistry.describe()).find((entry) => entry.id === 'pi')
      if (!descriptor) throw new Error('Pi Provider 未注册')
      return {
        id: stored.id,
        name: stored.label,
        bin: basename(stored.executable),
        path: stored.executable,
        version: versionProbe.version ?? descriptor.version,
        runtimeProvider: descriptor.runtimeProvider,
        transport: descriptor.transport,
        capabilities: descriptor.capabilities,
        health: descriptor.health,
        agentProfileId: stored.id
      }
    } catch (error) {
      const options = {
        type: 'error' as const,
        title: '无法添加 Pi Agent',
        message: '所选启动器未通过 Pi RPC 握手',
        detail: String((error as Error).message)
      }
      if (getWindow() && !getWindow()!.isDestroyed()) await dialog.showMessageBox(getWindow()!, options)
      else await dialog.showMessageBox(options)
      return null
    }
  })

  handleTrusted('agent:removePiProfile', (_event, id: unknown) => {
    if (typeof id !== 'string' || !/^pi:[a-f0-9]{16}$/.test(id)) throw new Error('无效的 Pi Agent Profile')
    piProfileStore().remove(id)
    invalidateRemoteProviderMetadata('pi')
    return true as const
  })

  handleTrusted('agent:providerDescriptors', () => providerRegistry.describe())

  handleTrusted('agent:recentFolders', () => recentStore().load())
  handleTrusted('agent:removeRecentFolder', (_event, dir: string) => recentStore().remove(dir))

  handleTrusted('agent:chooseFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return null
    const dir = canonicalExistingDirectory(r.filePaths[0])
    invalidateSessionHistoryLoad('workspace selection changed')
    rememberProject(dir)
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
