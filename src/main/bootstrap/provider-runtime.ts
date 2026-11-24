import { join } from 'node:path'
import { parseDisabledProviders, ProviderRegistry } from '../providers/registry'
import { ProviderCompatibilityStore } from '../provider-compatibility-manifest'
import { createBuiltInProviderAdapters } from '../providers'
import { createSmokeProviderAdapter, type SmokeFixtureProviderId } from '../providers/smoke'
import { sweepStalePrivateMcpConfigs } from '../providers/private-mcp-config'
import { ProviderSessionHost } from '../../host-runtime/provider-sessions/session-host'
import type { AntigravityProcessSession } from '../providers/antigravity-session'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { PiRunDiagnostics } from '../providers/pi-run-diagnostics'

/** C1: what the Pi pool reports; the daemon records it next to the Antigravity sessions. */
export interface PiSessionObserver {
  onOpened?: (key: string, provider: 'pi', at: number) => void
  onNativeSessionId?: (key: string, nativeSessionId: string) => void
  onReleased?: (key: string, reason: string, at: number) => void
}

export function createProviderRuntime(deps: {
  /** C1: the daemon owns Provider session lifetime because only it can record the release reason. */
  providerSessions?: ProviderSessionHost<AntigravityProcessSession>
  /** C1: Pi reports its pool lifecycle here so open/release reasons are stored, not logged. */
  piSessions?: PiSessionObserver
  /** C1: Codex reports its app-server pool lifecycle for the same reason. */
  codexSessions?: {
    onOpened?: (key: string, provider: 'codex', at: number) => void
    onNativeSessionId?: (key: string, nativeSessionId: string) => void
    onReleased?: (key: string, reason: string, at: number) => void
  }
  homeDir: string
  userDataDir: string
  appPath: string
  resourcesPath: string
  appVersion: string
  isPackaged: boolean
  listPiProfiles: () => Promise<PiAgentProfile[]>
  resolvePiProfile: (id: string) => Promise<PiAgentProfile | undefined>
}) {
  const { homeDir, userDataDir, appPath, resourcesPath, appVersion, isPackaged, listPiProfiles, resolvePiProfile } = deps
  // Crash recovery for private MCP config files (0600, same user only): an owner that died
  // mid-run never reached its cleanup. Off the startup path; only dead owners' files go.
  setTimeout(() => {
    sweepStalePrivateMcpConfigs().catch((error: NodeJS.ErrnoException) => {
      console.warn('[scry] private MCP config sweep failed:', error.code ?? 'unknown')
    })
  }, 5_000).unref()
  const piRunDiagnostics = new PiRunDiagnostics(join(userDataDir, 'pi-run-diagnostics.json'))
  // Two explicit gates. The App's packaged fixture keeps its original requirements; the
  // daemon is a plain Node process with no debug port, so an acceptance run asks for the
  // fixture by name instead, and only inside a daemon (SCRY_DAEMON_STATE_DIR is set by
  // daemonLaunchEnvironment alone). Neither gate can be reached by inheriting a normal
  // user environment.
  const smokeProviderEnabled = (process.env.SCRY_ELECTRON_SMOKE_PROVIDER === '1' &&
    process.env.ELECTRON_ENABLE_LOGGING === '1' &&
    process.argv.some((arg) => arg.startsWith('--remote-debugging-port='))) ||
    (process.env.SCRY_DAEMON_SMOKE_PROVIDER === '1' && process.env.SCRY_DAEMON_STATE_DIR !== undefined)
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
  const providerSessions = deps.providerSessions ?? new ProviderSessionHost<AntigravityProcessSession>()
  const builtInProviderAdapters = smokeProviderEnabled ? smokeProviderIds.map((id) => createSmokeProviderAdapter(id)) : createBuiltInProviderAdapters(
    homeDir,
    join(userDataDir, 'codex-home-v1'),
    join(userDataDir, 'provider-auth', 'opencode'),
    join(userDataDir, 'provider-state', 'opencode-v1'),
    {
      listProfiles: listPiProfiles, resolveProfile: resolvePiProfile, diagnostics: piRunDiagnostics,
      historyExtensionPath: join(isPackaged ? resourcesPath : join(appPath, 'resources'), 'scry-history', 'pi-history-reader.mjs'),
      ...(deps.piSessions ? { sessions: deps.piSessions } : {})
    },
    userDataDir,
    providerSessions,
    deps.codexSessions
  )
  /**
   * 兼容性策略在进程内保持一份。远端地址只有用户/部署配置了才会访问；
   * 没配置就只用内置策略，不产生额外网络请求。拉取失败不影响 Provider 探测。
   */
  const providerCompatibility = new ProviderCompatibilityStore({
    scryVersion: appVersion,
    cachePath: join(userDataDir, 'provider-compatibility-v1.json'),
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

  return {
    builtInProviderAdapters,
    providerCompatibility,
    providerRegistry,
    providerSessions,
    piRunDiagnostics,
    smokeProviderEnabled,
    smokeDetectedAgents
  }
}
