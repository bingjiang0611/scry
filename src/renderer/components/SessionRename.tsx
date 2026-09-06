import { useEffect, useId, useRef, useState } from 'react'
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from '@shared/session-title'
import type { SessionMeta } from '../env'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'

export interface SessionMenuTarget {
  cwd: string
  session: SessionMeta
  left: number
  top: number
  trigger: HTMLElement
}

export function SessionRenameMenu({ target, onRename, onClose }: {
  target: SessionMenuTarget
  onRename: (cwd: string, session: SessionMeta, title: string) => Promise<void>
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (editing) return
    menuRef.current?.querySelector('button')?.focus()
    const pointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', key)
    }
  }, [editing, onClose])
  if (editing) return <SessionRenameDialog title={target.session.preview}
    onSave={(title) => onRename(target.cwd, target.session, title)} onClose={onClose} />
  return (
    <div ref={menuRef} role="menu" aria-label="会话操作" className="menu sb-session-menu"
      style={{ left: target.left, top: target.top }}>
      <button type="button" role="menuitem" className="mitem" onClick={() => setEditing(true)}>
        <Icon name="edit" /> 重命名
      </button>
    </div>
  )
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
    <ModalFrame labelledBy={id} initialFocusRef={inputRef} className="project-dialog session-rename-dialog" onClose={close}>
      <div className="modal-head">
        <b id={id}>重命名会话</b>
        <button type="button" className="modal-x" aria-label="关闭重命名" disabled={saving} onClick={close}>×</button>
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
          <button type="button" className="btn" disabled={saving} onClick={close}>取消</button>
          <button type="submit" className="btn primary" disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </ModalFrame>
  )
}
