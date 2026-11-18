import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '../env'
import type { CatalogHealth } from '@shared/provider'
import { ipcErrorMessage } from '../constants/ipc-error-copy'

export function useWorkspaceState() {
  const [cwd, setCwd] = useState<string | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [catalogHealth, setCatalogHealth] = useState<CatalogHealth>({ status: 'ready', source: 'empty' })
  // A failed read is not an empty catalog and not a damaged index file: it keeps its own
  // state so the sidebar can say the read failed instead of "no projects" (B4-L4).
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [catalogHealthError, setCatalogHealthError] = useState<string | null>(null)
  const projectsRequestSeq = useRef(0)
  const readCatalogHealth = (): Promise<CatalogHealth> => typeof window.scry.catalogHealth === 'function'
    ? window.scry.catalogHealth()
    : Promise.resolve({ status: 'unavailable', source: 'empty', reason: '当前 preload 未暴露 catalog health' })

  const loadProjects = useCallback((): void => {
    const seq = ++projectsRequestSeq.current
    void Promise.allSettled([window.scry.listProjects(), readCatalogHealth()]).then(([nextProjects, nextHealth]) => {
      if (seq !== projectsRequestSeq.current) return
      if (nextProjects.status === 'fulfilled') { setProjects(nextProjects.value); setProjectsError(null) }
      else setProjectsError(ipcErrorMessage(nextProjects.reason))
      if (nextHealth.status === 'fulfilled') { setCatalogHealth(nextHealth.value); setCatalogHealthError(null) }
      else setCatalogHealthError(ipcErrorMessage(nextHealth.reason))
    })
  }, [])

  const refreshRecent = useCallback((): void => {
    window.scry.recentFolders().then(setRecent, () => undefined)
  }, [])

  const removeRecentFolder = useCallback(async (dir: string): Promise<void> => {
    setRecent(await window.scry.removeRecentFolder(dir))
  }, [])

  const chooseFolder = useCallback(async (): Promise<string | null> => {
    const dir = await window.scry.chooseFolder()
    if (dir) {
      setCwd(dir)
      refreshRecent()
      loadProjects()
    }
    return dir
  }, [loadProjects, refreshRecent])

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
      if (projectsCurrent) {
        if (nextProjects.status === 'fulfilled') { setProjects(nextProjects.value); setProjectsError(null) }
        else setProjectsError(ipcErrorMessage(nextProjects.reason))
      }
      if (nextRecent.status === 'fulfilled') setRecent(nextRecent.value)
      if (projectsCurrent) {
        if (nextHealth.status === 'fulfilled') { setCatalogHealth(nextHealth.value); setCatalogHealthError(null) }
        else setCatalogHealthError(ipcErrorMessage(nextHealth.reason))
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
    catalogHealthError,
    projectsError,
    loadProjects,
    refreshRecent,
    removeRecentFolder,
    chooseFolder
  }
}
