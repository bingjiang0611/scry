import { createPortal } from 'react-dom'
import { useEffect, useRef } from 'react'
import type { ProjectMeta } from '../env'
import { SIDEBAR_PROJECT_COPY as copy } from '../constants/copy'
import { usePresence } from '../hooks/usePresence'
import { MOTION } from '../motion'
import { Icon } from './primitives/Icon'
import { Menu, MenuItem, MenuSeparator } from './primitives/Menu'

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
  const presence = usePresence({ onClose, exitMs: MOTION.durationExitSm })
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
    if (!menuRef.current?.contains(document.activeElement)) menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', dismissPointer, true)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [presence.state, presence.requestClose])
  const content = (
    <Menu ref={(node) => { menuRef.current = node; presence.ref(node) }} className="menu sb-project-menu" data-state={presence.state}
      label={copy.manage(menu.project.name)} style={{ left: menu.left, top: menu.top, transformOrigin: 'top left' }}>
      <div className="sb-project-menu-head" role="none"><b>{menu.project.name}</b><code>{menu.project.cwd}</code></div>
      {onNewProjectChat && <MenuItem className="on" icon={<Icon name="plus" />} onClick={() => { onNewProjectChat(menu.project.cwd); presence.requestClose('button') }}>{copy.newChatAction}</MenuItem>}
      <MenuSeparator />
      {onToggleProjectPin && <MenuItem icon={<Icon name="pin" />} onClick={() => { onToggleProjectPin(menu.project); presence.requestClose('button') }}>{menu.project.pinnedAt ? copy.unpin : copy.pin}</MenuItem>}
      {onRevealProject && <MenuItem icon={<Icon name="folder" />} onClick={() => { onRevealProject(menu.project); presence.requestClose('button') }}>{copy.reveal}</MenuItem>}
      {onRenameProject && <MenuItem icon={<Icon name="settings" />} onClick={() => onRenameProject(menu.project)}>{copy.rename}</MenuItem>}
      <MenuSeparator />
      {onRemoveProject && <MenuItem danger className="sb-project-remove" icon={<Icon name="x" />} onClick={() => onRemoveProject(menu.project)}>{copy.remove}</MenuItem>}
    </Menu>
  )
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
