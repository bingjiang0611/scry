import { basename } from 'node:path'
import { providerDiscoveryCopy as copy } from '../shared/constants/provider-discovery-copy'
import type { BrowserWindow, Dialog, IpcMainInvokeEvent } from 'electron'
import { detectAgents, detectAgentsFast, PI_VERSION_PROBE_TIMEOUT_MS, probeCliVersion } from './claude-locate'
import type { DetectedAgent } from './claude-locate'
import { composeProviderDetectionResults, createCachedAsyncLoader } from './provider-detection'
import { piRpcEnvironment, probePiAgent } from './providers/pi'
import { piProfileForExecutable, type PiAgentProfile } from './pi-agent-profiles'
import type { ProviderCompatibilityStore } from './provider-compatibility-manifest'
import type { ProviderRegistry } from './providers/registry'
import { providerIdForAgentId } from '../shared/runtime'
import type { createPiAgentProfileStore } from './pi-agent-profiles'

/** Provider discovery and Pi profile IPC. Detection remains two-phase and profile writes keep their existing handshake and identity checks. */
export function registerProviderDiscoveryIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  providerRegistry: Pick<ProviderRegistry, 'describe'>
  providerCompatibility: Pick<ProviderCompatibilityStore, 'hydrate' | 'refresh' | 'advisory'>
  smokeProviderEnabled: boolean
  smokeDetectedAgents: DetectedAgent[]
  detectFast: typeof detectAgentsFast
  storedPiProfilesNotDetected: (detected: Array<{ id: string }>) => PiAgentProfile[]
  piProfileStore: () => Pick<ReturnType<typeof createPiAgentProfileStore>, 'add' | 'remove'>
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>
  window: () => BrowserWindow | null
  currentCwd: () => string | undefined
}) {
  const fullAgentDetection = createCachedAsyncLoader(() => detectAgents({
    versionProbeEnv: (agent, executable) => providerIdForAgentId(agent.id) === 'pi'
      ? piRpcEnvironment({ id: agent.id, label: agent.name, executable })
      : undefined
  }), { ttlMs: 60_000 })
  const detectInstalledAgents = () => fullAgentDetection.load()

  deps.handleTrusted('agent:detectFast', () => {
    if (deps.smokeProviderEnabled) return deps.smokeDetectedAgents
    const detected = deps.detectFast().flatMap((agent) => {
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
      ...deps.storedPiProfilesNotDetected(detected).map((profile) => ({
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

  deps.handleTrusted('agent:detect', async () => {
    // 让这次描述用上最新策略；hydrate/refresh 自己吞掉所有失败，不会阻断探测。
    await deps.providerCompatibility.hydrate()
    await deps.providerCompatibility.refresh()
    // 先异步完成 PATH/版本探测，让 descriptor 的同步 fallback 命中已知路径，避免阻塞主进程。
    // Capability disabling alone does not disable discovery's real --version subprocesses.
    const detected = deps.smokeProviderEnabled ? deps.smokeDetectedAgents : await detectInstalledAgents()
    const descriptors = await deps.providerRegistry.describe()
    return composeProviderDetectionResults({
      detected,
      descriptors,
      storedPiProfiles: deps.smokeProviderEnabled ? [] : deps.storedPiProfilesNotDetected(detected),
      probeStoredPiProfile: async (profile) => probeCliVersion(profile.executable, ['--version'], {
        env: await piRpcEnvironment(profile),
        timeout: PI_VERSION_PROBE_TIMEOUT_MS
      }),
      // adapter 自述的版本经常是空，本机真实版本来自 CLI 探测；用最终生效的版本重算判定。
      compatibility: (providerId, version) => deps.providerCompatibility.advisory(providerId, version)
    })
  })

  deps.handleTrusted('agent:addPiProfile', async () => {
    const result = await deps.dialog.showOpenDialog({ title: copy.selectLauncher, properties: ['openFile'] })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      const profile = piProfileForExecutable(result.filePaths[0])
      const versionProbe = await probeCliVersion(profile.executable, ['--version'], {
        env: await piRpcEnvironment(profile),
        timeout: PI_VERSION_PROBE_TIMEOUT_MS
      })
      await probePiAgent(profile, deps.currentCwd())
      const stored = deps.piProfileStore().add(profile)
      const descriptor = (await deps.providerRegistry.describe()).find((entry) => entry.id === 'pi')
      if (!descriptor) throw new Error(copy.providerMissing)
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
        title: copy.addFailed,
        message: copy.handshakeFailed,
        detail: String((error as Error).message)
      }
      const window = deps.window()
      if (window && !window.isDestroyed()) await deps.dialog.showMessageBox(window, options)
      else await deps.dialog.showMessageBox(options)
      return null
    }
  })

  deps.handleTrusted('agent:removePiProfile', (_event, id: unknown) => {
    if (typeof id !== 'string' || !/^pi:[a-f0-9]{16}$/.test(id)) throw new Error(copy.invalidProfile)
    deps.piProfileStore().remove(id)
    return true as const
  })
}
