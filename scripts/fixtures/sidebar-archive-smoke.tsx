import { useRef, useState } from 'react'
import { applySessionArchiveEffects } from '../../src/renderer/App'
import { Sidebar } from '../../src/renderer/components/Sidebar'
import { useWorkspaceState } from '../../src/renderer/hooks/useWorkspaceState'
import type { SessionMeta } from '../../src/renderer/env'

const cwd = '/fixture/rate-native'
const sessions: SessionMeta[] = [
  { sessionId: 'archive-target', externalSessionId: 'archive-target', providerId: 'qoder', preview: '归档目标', mtime: 2, count: 1 },
  { sessionId: 'keep-target', externalSessionId: 'keep-target', providerId: 'qoder', preview: '保留会话', mtime: 1, count: 1 }
]
// Only the typed catalog boundary is faked. The actual Sidebar, workspace refresh hook and
// archive coordinator run together; no Scry main/preload or user's catalog is accessible.
const api: Pick<Window['scry'], 'listProjects' | 'recentFolders' | 'catalogHealth'> = {
  listProjects: async () => [{ cwd, name: 'rate-native', mtime: 2, sessions: sessions.filter((session) => !session.archivedAt).map((session) => ({ ...session })) }],
  recentFolders: async () => [],
  catalogHealth: async () => ({ status: 'ready', source: 'primary' })
}
Object.defineProperty(window, 'scry', { value: api, configurable: true })

export function SidebarArchiveFixture() {
  const workspace = useWorkspaceState()
  const [active, setActive] = useState<string | null>('archive-target')
  const [undo, setUndo] = useState<SessionMeta | null>(null)
  const [status, setStatus] = useState('idle')
  const release = useRef<(() => void) | null>(null)
  const reject = useRef<(() => void) | null>(null)
  const archive = (_cwd: string, meta: SessionMeta) => {
    setStatus('pending')
    void applySessionArchiveEffects({
      archive: async () => {
        const target = sessions.find((session) => session.sessionId === meta.sessionId)
        if (!target) return false
        target.archivedAt = 1
        return true
      },
      archivingActiveSession: meta.sessionId === active,
      activeSessionBusy: false,
      rememberUndo: () => setUndo(meta),
      resetConversation: async () => {
        setActive(null)
        await new Promise<void>((resolve, fail) => {
          release.current = resolve
          reject.current = () => fail(new Error('fixture Provider catalog unavailable'))
        })
      },
      reloadProjects: workspace.loadProjects
    }).then(() => setStatus('settled'), () => setStatus('reset-failed'))
  }
  return <section id="archive-fixture">
    <output id="archive-status">{status}</output>
    <button id="release-catalog" onClick={() => release.current?.()}>完成清单刷新</button>
    <button id="reject-catalog" onClick={() => reject.current?.()}>清单刷新失败</button>
    <Sidebar id="archive-sidebar" projects={workspace.projects} activeCwd={cwd} activeSessionId={active} activeProviderId="qoder"
      onNewChat={() => setActive(null)} onPick={(_cwd, id) => setActive(id)} onTogglePin={() => undefined}
      onArchive={archive} archiveUndo={undo} onUndoArchive={() => {
        const target = sessions.find((session) => session.sessionId === undo?.sessionId)
        if (target) delete target.archivedAt
        setUndo(null)
        workspace.loadProjects()
      }} />
  </section>
}
