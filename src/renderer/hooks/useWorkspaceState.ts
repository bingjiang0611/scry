import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '../env'
import type { SessionProviderId } from '@shared/provider'
import type { CatalogHealth } from '@shared/provider'

export function useWorkspaceState() {
  const [cwd, setCwd] = useState<string | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [catalogHealth, setCatalogHealth] = useState<CatalogHealth>({ status: 'ready', source: 'empty' })
  const projectsRequestSeq = useRef(0)
  const readCatalogHealth = (): Promise<CatalogHealth> => typeof window.scry.catalogHealth === 'function'
    ? window.scry.catalogHealth()
    : Promise.resolve({ status: 'unavailable', source: 'empty', reason: '当前 preload 未暴露 catalog health' })

  const loadProjects = useCallback((): void => {
    const seq = ++projectsRequestSeq.current
    void Promise.allSettled([window.scry.listProjects(), readCatalogHealth()]).then(([nextProjects, nextHealth]) => {
      if (seq !== projectsRequestSeq.current) return
      if (nextProjects.status === 'fulfilled') setProjects(nextProjects.value)
      if (nextHealth.status === 'fulfilled') setCatalogHealth(nextHealth.value)
      else setCatalogHealth({ status: 'unavailable', source: 'empty', reason: String(nextHealth.reason) })
    })
  }, [])

  const refreshRecent = useCallback((): void => {
    window.scry.recentFolders().then(setRecent)
  }, [])

  const removeRecentFolder = useCallback(async (dir: string): Promise<void> => {
    setRecent(await window.scry.removeRecentFolder(dir))
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
    ++projectsRequestSeq.current
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
    let cancelled = false
    const projectsSeq = ++projectsRequestSeq.current
    void Promise.allSettled([
      window.scry.listProjects(),
      window.scry.recentFolders(),
      readCatalogHealth()
    ]).then(([nextProjects, nextRecent, nextHealth]) => {
      if (cancelled) return
      const projectsCurrent = projectsSeq === projectsRequestSeq.current
      if (nextProjects.status === 'fulfilled' && projectsCurrent) setProjects(nextProjects.value)
      if (nextRecent.status === 'fulfilled') setRecent(nextRecent.value)
      if (projectsCurrent) {
        if (nextHealth.status === 'fulfilled') setCatalogHealth(nextHealth.value)
        else setCatalogHealth({ status: 'unavailable', source: 'empty', reason: String(nextHealth.reason) })
      }
      setHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [loadProjects, refreshRecent])

  return {
    cwd,
    setCwd,
    recent,
    projects,
    setProjects,
    activeSessionId,
    setActiveSessionId,
    hydrated,
    catalogHealth,
    loadProjects,
    refreshRecent,
    removeRecentFolder,
    chooseFolder,
    removeSessionFromProjects
  }
}
