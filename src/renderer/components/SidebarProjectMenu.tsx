import { createPortal } from 'react-dom'
import { useEffect, useRef } from 'react'
import type { ProjectMeta } from '../env'
import { SIDEBAR_PROJECT_COPY as copy } from '../constants/copy'
import { usePresence } from '../hooks/usePresence'
import { Icon } from './primitives/Icon'

type ProjectMenuTarget = { project: ProjectMeta; left: number; top: number }

export function SidebarProjectMenu({
  menu,
  onClose,
  onNewProjectChat,
  onToggleProjectPin,
  onRevealProject,
  onRenameProject,
  onRemoveProject
}: {
  menu: ProjectMenuTarget
  onClose: () => void
  onNewProjectChat?: (cwd: string) => void
  onToggleProjectPin?: (project: ProjectMeta) => void
  onRevealProject?: (project: ProjectMeta) => void
  onRenameProject?: (project: ProjectMeta) => void
  onRemoveProject?: (project: ProjectMeta) => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const presence = usePresence({ onClose, exitMs: 100 })
  useEffect(() => {
    if (presence.state === 'exit') return
    const dismissPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) presence.requestClose('pointer')
    }
    const dismissEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); presence.requestClose('escape') }
    }
    document.addEventListener('pointerdown', dismissPointer, true)
    document.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissPointer, true)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [presence.state, presence.requestClose])
  const content = (
    <div ref={(node) => { menuRef.current = node; presence.ref(node) }} className="menu sb-project-menu" data-state={presence.state}
      role="menu" aria-label={copy.manage(menu.project.name)} style={{ left: menu.left, top: menu.top, transformOrigin: 'top left' }}>
      <div className="sb-project-menu-head"><b>{menu.project.name}</b><code>{menu.project.cwd}</code></div>
      {onNewProjectChat && <button type="button" className="mitem on" onClick={() => { onNewProjectChat(menu.project.cwd); presence.requestClose('button') }}><Icon name="plus" /> {copy.newChatAction}</button>}
      <div className="mdiv" />
      {onToggleProjectPin && <button type="button" className="mitem" onClick={() => { onToggleProjectPin(menu.project); presence.requestClose('button') }}><Icon name="pin" /> {menu.project.pinnedAt ? copy.unpin : copy.pin}</button>}
      {onRevealProject && <button type="button" className="mitem" onClick={() => { onRevealProject(menu.project); presence.requestClose('button') }}><Icon name="folder" /> {copy.reveal}</button>}
      {onRenameProject && <button type="button" className="mitem" onClick={() => onRenameProject(menu.project)}><Icon name="settings" /> {copy.rename}</button>}
      <div className="mdiv" />
      {onRemoveProject && <button type="button" className="mitem sb-project-remove" onClick={() => onRemoveProject(menu.project)}><Icon name="x" /> {copy.remove}</button>}
    </div>
  )
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
