import { homedir } from 'node:os'
import { HomeFileAccess } from '../home-file-access'
import { createRecentFoldersStore, createProjectStore, isManagedWorktreePath } from '../app-store'
import { canonicalExistingDirectory, knownProjectDirectory } from '../workspace-authorization'
import { canonicalRemoteProjectRoots, resolveRemoteProjectDirectory as resolveRemoteDescendant } from '../remote/remote-directory-browser'

export function createWorkspaceRuntime(deps: { appUserDataDir: string; loadSessions: () => Array<{ cwd?: string }> }) {
  const homeDir = homedir()
  const homeFileAccess = new HomeFileAccess(homeDir)
  let recentStoreInstance: ReturnType<typeof createRecentFoldersStore> | undefined
  const recentStore = () => recentStoreInstance ??= createRecentFoldersStore(deps.appUserDataDir)
  let projectStoreInstance: ReturnType<typeof createProjectStore> | undefined
  const projectStore = () => projectStoreInstance ??= createProjectStore(deps.appUserDataDir)
  const rememberProject = (cwd: string): void => {
    const canonical = canonicalExistingDirectory(cwd)
    // 打开 worktree 里的会话会以执行 cwd 调用这里；记成项目会在侧栏冒出一个空项目。
    if (isManagedWorktreePath(deps.appUserDataDir, canonical)) return
    const alreadyCurrent = recentStore().load()[0] === canonical &&
      projectStore().load().some(project => project.cwd === canonical && !project.removedAt)
    if (alreadyCurrent) return
    recentStore().push(canonical)
    projectStore().remember(canonical)
  }
  const knownProjectDirectories = (): Set<string> => new Set([
    ...recentStore().load(),
    ...projectStore().load().filter((project) => !project.removedAt).map((project) => project.cwd),
    ...deps.loadSessions().map((session) => session.cwd).filter((cwd): cwd is string => Boolean(cwd))
  ])
  const resolveKnownProjectDirectory = (cwd: string): string => knownProjectDirectory(cwd, knownProjectDirectories())
  const remoteProjectRoots = (): string[] => canonicalRemoteProjectRoots(knownProjectDirectories())
  const resolveRemoteProjectDirectory = (cwd: string): string => resolveRemoteDescendant(cwd, knownProjectDirectories())

  return { homeDir, homeFileAccess, recentStore, projectStore, rememberProject, knownProjectDirectories, resolveKnownProjectDirectory, remoteProjectRoots, resolveRemoteProjectDirectory }
}
