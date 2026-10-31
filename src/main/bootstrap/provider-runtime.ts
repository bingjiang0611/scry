import { app } from 'electron'
import { join } from 'node:path'
import { parseDisabledProviders, ProviderRegistry } from '../providers/registry'
import { ProviderCompatibilityStore } from '../provider-compatibility-manifest'
import { createBuiltInProviderAdapters } from '../providers'
import { createSmokeProviderAdapter, type SmokeFixtureProviderId } from '../providers/smoke'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { PiRunDiagnostics } from '../providers/pi-run-diagnostics'

export function createProviderRuntime(deps: { homeDir: string; listPiProfiles: () => Promise<PiAgentProfile[]>; resolvePiProfile: (id: string) => Promise<PiAgentProfile | undefined> }) {
  const { homeDir, listPiProfiles, resolvePiProfile } = deps
  const piRunDiagnostics = new PiRunDiagnostics(join(app.getPath('userData'), 'pi-run-diagnostics.json'))
  const smokeProviderEnabled = process.env.SCRY_ELECTRON_SMOKE_PROVIDER === '1' &&
    process.env.ELECTRON_ENABLE_LOGGING === '1' &&
    process.argv.some((arg) => arg.startsWith('--remote-debugging-port='))
  // Two explicit fixture sets: the historical conversation set stays Claude/Codex/Pi, and
  // the side-chat set covers every shipped target so one acceptance run can drive all five.
  // Nothing here changes the default: without the gate the list is Codex only.
  const smokeProviderIds: SmokeFixtureProviderId[] = process.env.SCRY_ELECTRON_SMOKE_SIDE_CHAT === '1'
    ? ['claude', 'codex', 'qoder', 'opencode', 'pi']
    : process.env.SCRY_ELECTRON_SMOKE_CONVERSATIONS === '1' ? ['codex', 'claude', 'pi'] : ['codex']
  const smokeDetectedAgents = smokeProviderIds.map(id => ({
    id: id === 'pi' ? 'pi:0123456789abcdef' : id,
    name: id === 'pi' ? 'Pi · Rotom Smoke Fixture' : `${id} Smoke Fixture`, bin: id, path: process.execPath
  }))
  const builtInProviderAdapters = smokeProviderEnabled ? smokeProviderIds.map((id) => createSmokeProviderAdapter(id)) : createBuiltInProviderAdapters(
    homeDir,
    join(app.getPath('userData'), 'codex-home-v1'),
    join(app.getPath('userData'), 'provider-auth', 'opencode'),
    join(app.getPath('userData'), 'provider-state', 'opencode-v1'),
    {
      listProfiles: listPiProfiles, resolveProfile: resolvePiProfile, diagnostics: piRunDiagnostics,
      historyExtensionPath: join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'scry-history', 'pi-history-reader.mjs')
    }
  )
  /**
   * 兼容性策略在进程内保持一份。远端地址只有用户/部署配置了才会访问；
   * 没配置就只用内置策略，不产生额外网络请求。拉取失败不影响 Provider 探测。
   */
  const providerCompatibility = new ProviderCompatibilityStore({
    scryVersion: app.getVersion(),
    cachePath: join(app.getPath('userData'), 'provider-compatibility-v1.json'),
    ...(process.env.SCRY_PROVIDER_MANIFEST_URL?.trim()
      ? { remoteUrl: process.env.SCRY_PROVIDER_MANIFEST_URL.trim() }
      : {})
  })
  const providerRegistry = new ProviderRegistry(
    builtInProviderAdapters,
    {
      disabledProviders: parseDisabledProviders(process.env.SCRY_DISABLED_PROVIDERS),
      runControlsEnabled: process.env.SCRY_RUN_CONTROLS?.trim() !== '0',
      compatibility: (providerId, version) => providerCompatibility.advisory(providerId, version)
    }
  )

  return { builtInProviderAdapters, providerCompatibility, providerRegistry, piRunDiagnostics, smokeProviderEnabled, smokeDetectedAgents }
}
