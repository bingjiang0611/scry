import { useCallback, useEffect, useState } from 'react'
import type { ProjectMeta } from '../env'
import type { SessionProviderId } from '@shared/provider'

export function useWorkspaceState() {
  const [cwd, setCwd] = useState<string | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const loadProjects = useCallback((): void => {
    window.scry.listProjects().then(setProjects)
  }, [])

  const refreshRecent = useCallback((): void => {
    window.scry.recentFolders().then(setRecent)
  }, [])

  const chooseFolder = useCallback(async (): Promise<string | null> => {
    const dir = await window.scry.chooseFolder()
    if (dir) {
      setCwd(dir)
      refreshRecent()
    }
    return dir
  }, [refreshRecent])

  const removeSessionFromProjects = useCallback((projectCwd: string, sessionId: string, providerId: SessionProviderId): void => {
    setProjects((prev) =>
      prev
        .map((project) =>
          project.cwd === projectCwd
            ? {
                ...project,
                sessions: project.sessions.filter(
                  (session) => !(session.sessionId === sessionId && session.providerId === providerId)
                )
              }
            : project
        )
        .filter((project) => project.sessions.length > 0)
    )
  }, [])

  useEffect(() => {
    loadProjects()
    refreshRecent()
  }, [loadProjects, refreshRecent])

  return {
    cwd,
    setCwd,
    recent,
    projects,
    setProjects,
    activeSessionId,
    setActiveSessionId,
    loadProjects,
    refreshRecent,
    chooseFolder,
    removeSessionFromProjects
  }
}
