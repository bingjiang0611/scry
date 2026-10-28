import { detectAgentsFast } from './claude-locate'
import { createPiAgentProfileStore, piProfileForExecutable, undetectedPiProfiles, type PiAgentProfile } from './pi-agent-profiles'
import { discoverTraceArchiveSessionsAsync } from './transcript-archive'
import { knownProjectDirectory, knownProjectDirectoryAsync } from './workspace-authorization'
import { canonicalRemoteProjectRoots, resolveRemoteProjectDirectory as resolveRemoteDescendant } from './remote/remote-directory-browser'
import { createAppSessionStore, createProjectStore, createRecentFoldersStore, mergeProjectMetas, type ProjectMeta } from './app-store'
import type { ConversationService } from './conversation-service'
import type { ProviderId } from '../shared/provider'

export interface MainCatalogRuntimeDeps {
  getUserData: () => string
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  conversationService: () => ConversationService
  providerIdForAgentId: (id: string) => ProviderId | undefined
  canonicalExistingDirectory: (cwd: string) => string
}

export function createMainCatalogRuntime(deps: MainCatalogRuntimeDeps) {
  const recentStore = () => createRecentFoldersStore(deps.getUserData())
  const projectStore = () => createProjectStore(deps.getUserData())
  const rememberProject = (cwd: string): void => {
    const canonical = deps.canonicalExistingDirectory(cwd)
    recentStore().push(canonical)
    projectStore().remember(canonical)
  }
  const knownProjectDirectories = (): Set<string> => new Set([
    ...recentStore().load(),
    ...projectStore().load().filter((project) => !project.removedAt).map((project) => project.cwd),
    ...deps.appSessionStore().load().filter((session) => !session.workspaceScope).map((session) => session.cwd).filter(Boolean)
  ])
  const resolveKnownProjectDirectory = (cwd: string): string => knownProjectDirectory(cwd, knownProjectDirectories())
  const resolveTemplateProjectDirectory = async (cwd: string): Promise<string> => {
    const [recent, projects, sessions] = await Promise.all([recentStore().loadAsync(), projectStore().loadAsync(), deps.appSessionStore().loadAsync()])
    return knownProjectDirectoryAsync(cwd, new Set([
      ...recent,
      ...projects.filter((project) => !project.removedAt).map((project) => project.cwd),
      ...sessions.filter((session) => !session.workspaceScope).map((session) => session.cwd).filter(Boolean)
    ]))
  }
  const remoteProjectRoots = (): string[] => canonicalRemoteProjectRoots(knownProjectDirectories())
  const resolveRemoteProjectDirectory = (cwd: string): string => resolveRemoteDescendant(cwd, knownProjectDirectories())
  let traceCatalogRecovery: Promise<void> | null = null
  const recoverTraceCatalogOnce = (): Promise<void> => {
    if (traceCatalogRecovery) return traceCatalogRecovery
    traceCatalogRecovery = (async () => {
      const store = deps.appSessionStore()
      const catalog = store.load()
      const knownCwds = new Set(catalog.map((session) => session.cwd))
      const scopedCwds = new Set(catalog.filter((session) => session.workspaceScope).map((session) => session.cwd))
      const known = new Set(catalog.flatMap((session) => session.externalSessionId
        ? [`${session.providerId}\0${session.agentProfileId ?? ''}\0${session.cwd}\0${session.externalSessionId}`] : []))
      for (const summary of await discoverTraceArchiveSessionsAsync(deps.getUserData())) {
        if (summary.providerId !== 'qoder' || !knownCwds.has(summary.cwd)) continue
        const key = `${summary.providerId}\0\0${summary.cwd}\0${summary.sessionId}`
        if (known.has(key)) continue
        store.record({ providerId: summary.providerId, runtimeProvider: summary.runtimeProvider, runId: summary.runId,
          externalSessionId: summary.sessionId, cwd: summary.cwd, prompt: summary.prompt,
          workspaceScope: scopedCwds.has(summary.cwd) ? 'workflow_replica' : undefined })
        known.add(key)
      }
    })()
    return traceCatalogRecovery
  }
  const listProjectCatalog = async (): Promise<ProjectMeta[]> => {
    await recoverTraceCatalogOnce()
    const sessionProjects = deps.appSessionStore().listProjects()
    const now = Date.now()
    const observed = new Map<string, number>()
    recentStore().load().forEach((cwd: string, index: number) => observed.set(cwd, now - index))
    for (const project of sessionProjects) {
      if (project.cwd) observed.set(project.cwd, Math.max(observed.get(project.cwd) ?? 0, project.mtime))
    }
    const store = projectStore()
    store.seed([...observed].map(([cwd, lastOpenedAt]) => ({ cwd, lastOpenedAt })))
    const projects = mergeProjectMetas(store.load(), sessionProjects)
    return Promise.all(projects.map(async (project) => {
      const conversations = await deps.conversationService().list(project.cwd)
      const ownedNativeAliases = await deps.conversationService().nativeSessionAliases(project.cwd)
      return {
        ...project,
        sessions: project.sessions.filter((session) => {
          const nativeId = session.externalSessionId ?? session.sessionId
          const alias = `${session.providerId}\0${session.agentProfileId ?? ''}\0${project.cwd}\0${nativeId}`
          return !ownedNativeAliases.has(alias)
        }),
        conversations
      }
    }))
  }
  const piProfileStore = () => createPiAgentProfileStore(deps.getUserData())
  const detectedPiProfiles = async (): Promise<PiAgentProfile[]> => detectAgentsFast().flatMap((agent) => {
    if (deps.providerIdForAgentId(agent.id) !== 'pi') return []
    try { const profile = piProfileForExecutable(agent.path); return [{ ...profile, id: agent.id, label: agent.name }] } catch { return [] }
  })
  const storedPiProfiles = (): PiAgentProfile[] => {
    try { return piProfileStore().load().flatMap((stored) => { try { const current = piProfileForExecutable(stored.executable); return [{ ...current, id: stored.id, label: stored.label }] } catch { return [] } }) } catch { return [] }
  }
  const storedPiProfilesNotDetected = (detected: Array<{ id: string }>): PiAgentProfile[] => undetectedPiProfiles(storedPiProfiles(), detected)
  const listPiProfiles = async (): Promise<PiAgentProfile[]> => {
    const detected = await detectedPiProfiles()
    return [...detected, ...storedPiProfilesNotDetected(detected.map((profile) => ({ id: profile.id, path: profile.executable })))]
  }
  const resolvePiProfile = async (id: string): Promise<PiAgentProfile | undefined> => {
    if (id === 'pi:default' || id === 'pi:rotom') return (await detectedPiProfiles()).find((profile) => profile.id === id)
    return storedPiProfiles().find((profile) => profile.id === id)
  }
  return { recentStore, projectStore, rememberProject, knownProjectDirectories, resolveKnownProjectDirectory,
    resolveTemplateProjectDirectory, remoteProjectRoots, resolveRemoteProjectDirectory, listProjectCatalog,
    listPiProfiles, resolvePiProfile, piProfileStore, storedPiProfilesNotDetected }
}
