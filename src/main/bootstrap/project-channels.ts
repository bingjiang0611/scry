import { basename, isAbsolute } from 'node:path'
import type { ProviderContext, ProviderId } from '../../shared/provider'
import type { ProviderRegistry } from '../providers/registry'
import { piProfileForExecutable, resolvePiLauncherExecutable, type PiAgentProfile } from '../pi-agent-profiles'
import { probeCliVersion, PI_VERSION_PROBE_TIMEOUT_MS } from '../claude-locate'
import { piRpcEnvironment, probePiAgent } from '../providers/pi'
import type { ChannelHandlers } from './startup-channels'

// Project list, recent folders, the chosen workspace folder, Provider context invalidation
// and Pi profiles: the handlers Electron main registers and the daemon serves as local
// ops (B4-L4), one implementation so the two cannot drift. No Electron values here: the
// pickers and dialogs stay with the window (app-agent.ts in process, project-daemon.ts
// in daemon mode). The recent folders and projects written here are the workspace
// authorization input (knownProjectDirectories), so in daemon mode only the daemon
// writes them.

type WithProviderOperation = <T>(providerId: ProviderId, operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>

export function projectCwdFromRequest(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096) throw new Error('无效的项目目录')
  return value
}

/** Pin, rename and remove one project of the sidebar list. */
export function projectStoreChannelHandlers(deps: {
  projectStore: () => { setPinned: (cwd: string, pinned: boolean) => boolean; rename: (cwd: string, name: string) => boolean; remove: (cwd: string) => void }
  recentStore: () => { remove: (cwd: string) => void }
}) {
  return {
    'agent:setProjectPinned': (cwd: unknown, pinned: unknown) => {
      if (typeof pinned !== 'boolean') throw new Error('无效的项目置顶请求')
      return deps.projectStore().setPinned(projectCwdFromRequest(cwd), pinned)
    },
    'agent:renameProject': (cwd: unknown, name: unknown) => {
      const label = typeof name === 'string' ? name.trim() : ''
      if (!label || label.length > 120) throw new Error('项目名称必须为 1–120 个字符')
      return deps.projectStore().rename(projectCwdFromRequest(cwd), label)
    },
    'agent:removeProject': (cwd: unknown) => {
      const dir = projectCwdFromRequest(cwd)
      deps.projectStore().remove(dir)
      deps.recentStore().remove(dir)
      return true as const
    }
  } satisfies ChannelHandlers
}

/** Drop one entry of the recent folders; answers the list the renderer shows next. */
export function recentFolderChannelHandlers(deps: { recentStore: () => { remove: (cwd: string) => string[] } }) {
  return {
    // Removal only narrows the authorization input, so no project check; a non-string
    // used to rewrite the file unchanged and is refused now.
    'agent:removeRecentFolder': (dir: unknown) => {
      if (typeof dir !== 'string' || dir.length > 4_096) throw new Error('无效的最近目录')
      return deps.recentStore().remove(dir)
    }
  } satisfies ChannelHandlers
}

/**
 * Forget a Provider context's warm caches (models, skills, controls). Queued with the
 * Provider's auth operations; the remote metadata refresh runs even when the adapter
 * fails, as it did in main. A context without a cwd means the current workspace.
 */
export function providerContextChannelHandlers(deps: {
  // get() refuses an unknown Provider before anything is queued.
  providerRegistry: Pick<ProviderRegistry, 'invalidateContext'> & { get: (providerId: ProviderId) => unknown }
  withProviderOperation: WithProviderOperation
  invalidateDiscovery: (providerId: ProviderId) => void
  refreshInvalidatedMetadata: () => void
  currentCwd: () => string | undefined
}) {
  return {
    'agent:invalidateProviderContext': async (context: ProviderContext) => {
      const normalizedContext = { ...context, cwd: context.cwd ?? deps.currentCwd() }
      deps.providerRegistry.get(normalizedContext.providerId)
      await deps.withProviderOperation(normalizedContext.providerId, async () => {
        deps.invalidateDiscovery(normalizedContext.providerId)
        try {
          await deps.providerRegistry.invalidateContext(normalizedContext)
        } finally {
          deps.refreshInvalidatedMetadata()
        }
      }, normalizedContext.agentProfileId)
      return true as const
    }
  } satisfies ChannelHandlers
}

/** Remove a Pi profile the user added; detected launchers (pi:default, pi:rotom) are not stored. */
export function piProfileChannelHandlers(deps: {
  piProfileStore: () => { remove: (id: string) => void }
  invalidateRemoteProviderMetadata: (providerId: 'pi') => void
}) {
  return {
    'agent:removePiProfile': (id: unknown) => {
      if (typeof id !== 'string' || !/^pi:[a-f0-9]{16}$/.test(id)) throw new Error('无效的 Pi Agent Profile')
      deps.piProfileStore().remove(id)
      deps.invalidateRemoteProviderMetadata('pi')
      return true as const
    }
  } satisfies ChannelHandlers
}

/**
 * The folder the picker chose becomes a project: its canonical directory (symlinks
 * resolved, must exist) is what is remembered and what the window then selects. Loads
 * of the previous workspace's history are dropped first, as in main.
 */
export function rememberChosenFolder(deps: {
  canonicalExistingDirectory: (cwd: string) => string
  invalidateSessionHistoryLoad: (reason: string) => void
  rememberProject: (cwd: string) => void
}, picked: unknown): string {
  if (typeof picked !== 'string') throw new Error('无效的工作目录')
  const dir = deps.canonicalExistingDirectory(picked)
  deps.invalidateSessionHistoryLoad('workspace selection changed')
  deps.rememberProject(dir)
  return dir
}

/** A launcher path as the picker hands it over; anything else never came from a picker. */
export function piLauncherFromRequest(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096) throw new Error('无效的 Pi Agent 启动器')
  return value
}

/** What the daemon answers the App for a picked launcher: the App shows a failure itself. */
export type PiProfileAddition =
  | { status: 'added'; agent: Awaited<ReturnType<typeof addPiProfileFromLauncher>> }
  | { status: 'failed'; message: string }

/**
 * Add the launcher the user picked: resolve it, check its version and complete a Pi RPC
 * handshake in `cwd` (the window's workspace, or home) before storing it. Throws on any
 * failure; the caller turns that into the window's error dialog.
 */
export async function addPiProfileFromLauncher(deps: {
  piProfileStore: () => { add: (profile: PiAgentProfile) => PiAgentProfile }
  providerRegistry: Pick<ProviderRegistry, 'describe'>
  invalidateRemoteProviderMetadata: (providerId: 'pi') => void
}, launcher: string, cwd: string | undefined) {
  const profile = piProfileForExecutable(await resolvePiLauncherExecutable(launcher))
  const versionProbe = await probeCliVersion(profile.executable, ['--version'], {
    env: await piRpcEnvironment(profile),
    timeout: PI_VERSION_PROBE_TIMEOUT_MS
  })
  await probePiAgent(profile, cwd)
  const stored = deps.piProfileStore().add(profile)
  deps.invalidateRemoteProviderMetadata('pi')
  const descriptor = (await deps.providerRegistry.describe()).find((entry) => entry.id === 'pi')
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
}
