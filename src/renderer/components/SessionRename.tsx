import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from '@shared/session-title'
import type { ConversationSummary } from '@shared/conversation-api'
import { ConversationAdoptionDialog } from './ConversationAdoptionDialog'
import type { SessionMeta } from '../env'
import { ModalFrame, requestModalClose } from './Modals'
import { usePresence } from '../hooks/usePresence'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY } from '../constants/copy'

export interface SessionMenuTarget {
  cwd: string
  session: SessionMeta
  left: number
  top: number
  trigger: HTMLElement
}

export function SessionRenameMenu({ target, onRename, onAdopted, onClose }: {
  target: SessionMenuTarget
  onRename: (cwd: string, session: SessionMeta, title: string) => Promise<void>
  onAdopted?: (conversation: ConversationSummary) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState<'rename' | 'adopt'>()
  const provider = target.session.providerId
  const presence = usePresence({ onClose, exitMs: 100, onExitStart: () => target.trigger.focus() })
  const canAdopt = Boolean(onAdopted && !target.session.agentProfileId && (provider === 'claude' || provider === 'codex'))
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (editing || presence.state === 'exit') return
    menuRef.current?.querySelector('button')?.focus()
    const pointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) presence.requestClose('pointer')
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      }
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault()
        presence.requestClose('escape')
      }
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', key)
    }
  }, [editing, presence.state, presence.requestClose])
  if (editing === 'adopt' && onAdopted && (provider === 'claude' || provider === 'codex')) return <ConversationAdoptionDialog
    source={{ providerId: provider, cwd: target.cwd, externalSessionId: target.session.externalSessionId ?? target.session.sessionId }}
    onAdopted={onAdopted} onClose={onClose} />
  if (editing === 'rename') return <SessionRenameDialog title={target.session.preview}
    onSave={(title) => onRename(target.cwd, target.session, title)} onClose={onClose} />
  const menu = (
    <div ref={(node) => { menuRef.current = node; presence.ref(node) }} role="menu" aria-label="会话操作" className="menu sb-session-menu" data-state={presence.state}
      style={{ left: target.left, top: Math.min(target.top, (typeof window === 'undefined' ? target.top : window.innerHeight) - (canAdopt ? 96 : 48)), transformOrigin: 'top left' }}>
      <button type="button" role="menuitem" className="mitem" onClick={() => { target.trigger.focus(); setEditing('rename') }}>
        <Icon name="edit" /> 重命名
      </button>
      {canAdopt && <button type="button" role="menuitem" className="mitem" disabled={target.session.pending} onClick={() => { target.trigger.focus(); setEditing('adopt') }}>迁入已捕获历史…</button>}
    </div>
  )
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}

export function SessionRenameDialog({ title, onSave, onClose }: {
  title: string
  onSave: (title: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => { inputRef.current?.select() }, [])
  const close = (): void => { if (!pending.current) onClose() }
  const save = async (): Promise<void> => {
    if (pending.current) return
    setError(null)
    try {
      const next = normalizeSessionTitle(name)
      pending.current = true
      setSaving(true)
      await onSave(next)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  return (
    <ModalFrame labelledBy={id} initialFocusRef={inputRef} className="project-dialog session-rename-dialog" closeDisabled={saving} onClose={close}>
      <div className="modal-head">
        <b id={id}>重命名会话</b>
        <ModalCloseButton aria-label={MODAL_COPY.closeRename} disabled={saving} onClick={() => requestModalClose()}>×</ModalCloseButton>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void save() }} aria-busy={saving}>
        <div className="project-dialog-body">
          <p id={`${id}-hint`}>取一个简短、容易辨认的名称。仅修改 Scry 中的显示名称。</p>
          <label>
            <span>会话名称</span>
            <input ref={inputRef} value={name} maxLength={SESSION_TITLE_MAX_LENGTH} disabled={saving}
              aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} aria-invalid={error ? true : undefined}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => { setName(event.target.value); setError(null) }} />
          </label>
          {error && <p id={`${id}-error`} role="alert" className="session-rename-error">{error}</p>}
        </div>
        <div className="project-dialog-actions">
          <button type="button" className="btn" disabled={saving} onClick={() => requestModalClose()}>取消</button>
          <button type="submit" className="btn primary" disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </ModalFrame>
  )
}
