import { basename } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderContext } from '../../shared/provider'
import { installDaemonChannelResultHandler } from '../daemon-channel-gate'
import { providerIdForAgentId } from '../../shared/runtime'
import { canonicalizePiAgentPaths, type PiAgentProfile } from '../pi-agent-profiles'
import { detectAgentsFast, probeCliVersion, PI_VERSION_PROBE_TIMEOUT_MS, type DetectedAgent } from '../claude-locate'
import { piRpcEnvironment } from '../providers/pi'
import type { ProviderRegistry } from '../providers/registry'
import type { ProviderCompatibilityStore } from '../provider-compatibility-manifest'
import { composeProviderDetectionResults } from '../provider-detection'
import type { createAppSessionStore, ProjectMeta } from '../app-store'

// Channel handlers that both Electron main and the daemon register: main for the
// in-process App, the daemon as local ops for an App whose runs it owns (B4-L4). One
// implementation, so the two answers cannot drift. No Electron values are used here.
export type ChannelHandler = (...args: never[]) => unknown
export type ChannelHandlers = Readonly<Record<string, ChannelHandler>>

type TrustedRegistrar = <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void

export function registerChannelHandlers(handleTrusted: TrustedRegistrar, handlers: ChannelHandlers): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    handleTrusted(channel, (_event, ...args: unknown[]) => (handler as (...values: unknown[]) => unknown)(...args))
  }
}

/** Sidebar catalog reads: the App's own sessions, projects and recent folders. */
export function catalogChannelHandlers(deps: {
  appSessionStore: () => Pick<ReturnType<typeof createAppSessionStore>, 'listSessions' | 'health'>
  listProjectCatalog: () => Promise<ProjectMeta[]>
  recentStore: () => { load: () => string[] }
}) {
  return {
    // Single-directory session list (the current workspace): only sessions the App started.
    'agent:listSessions': (context: ProviderContext) =>
      deps.appSessionStore().listSessions(context.cwd ?? '', context.providerId, context.agentProfileId),
    // The sidebar keeps projects independent of sessions; older data is backfilled once
    // from recent folders and the App session catalog.
    'agent:listProjects': () => deps.listProjectCatalog(),
    'agent:catalogHealth': () => deps.appSessionStore().health(),
    'agent:recentFolders': () => deps.recentStore().load()
  } satisfies ChannelHandlers
}

/** Installed Provider discovery and the descriptors the composer renders. */
export function providerDetectionChannelHandlers(deps: {
  smokeProviderEnabled: boolean
  smokeDetectedAgents: DetectedAgent[]
  storedPiProfilesNotDetected: (detected: Array<{ id: string }>) => PiAgentProfile[]
  providerCompatibility: ProviderCompatibilityStore
  detectInstalledAgents: () => Promise<DetectedAgent[]>
  providerRegistry: ProviderRegistry
}) {
  const { smokeProviderEnabled, smokeDetectedAgents, storedPiProfilesNotDetected, providerCompatibility, detectInstalledAgents, providerRegistry } = deps
  return {
    'agent:detectFast': async () => {
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
    },
    'agent:detect': async () => {
      // Use the newest policy for this description; hydrate/refresh swallow their own
      // failures and never block detection.
      await providerCompatibility.hydrate()
      await providerCompatibility.refresh()
      // Finish the async PATH/version probe first so the descriptor's synchronous
      // fallback hits a known path instead of blocking the main process. Capability
      // disabling alone does not disable discovery's real --version subprocesses.
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
        // Adapters often report an empty version; the real local version comes from the
        // CLI probe, so judge compatibility on the version that finally applies.
        compatibility: (providerId, version) => providerCompatibility.advisory(providerId, version)
      })
    },
    'agent:providerDescriptors': () => providerRegistry.describe()
  } satisfies ChannelHandlers
}

/** Run controls for one Provider context, queued with that Provider's auth operations. */
export function providerControlChannelHandlers(deps: {
  providerRegistry: Pick<ProviderRegistry, 'runControls'>
  withProviderOperation: <T>(providerId: ProviderContext['providerId'], operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>
}) {
  return {
    'agent:runControls': (context: ProviderContext) =>
      deps.withProviderOperation(context.providerId, () => deps.providerRegistry.runControls(context), context.agentProfileId)
  } satisfies ChannelHandlers
}

/**
 * `agent:newSession` without the window's part: forget this context's current session and
 * the Provider's warm state for it. Main adds the badge (nothing is viewed now); in daemon
 * mode the daemon runs this and main applies the badge once it answered.
 */
export async function resetProviderSession(deps: {
  providerRegistry: { invalidateContext: (context: ProviderContext) => void | Promise<void> }
  providerContextKey: (providerId: ProviderContext['providerId'], cwd: string, agentProfileId?: string) => string
  resetSessionContext: (key: string) => void
  currentCwd: () => string | undefined
}, context: ProviderContext | undefined): Promise<true> {
  const cwd = context?.cwd ?? deps.currentCwd()
  if (context?.providerId) {
    deps.resetSessionContext(deps.providerContextKey(context.providerId, cwd ?? '', context.agentProfileId))
    await deps.providerRegistry.invalidateContext({ ...context, cwd })
  }
  return true
}

/** Daemon mode: once the daemon reset the context, this window views no session. */
export function viewNothingAfterDaemonNewSession(dockBadge: { view: (key: string | null, focused: boolean) => void }, isFocused: () => boolean): () => void {
  return installDaemonChannelResultHandler('agent:newSession', (value) => {
    dockBadge.view(null, isFocused())
    return value
  })
}
