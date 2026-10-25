import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionMeta } from '../env'
import { relTime } from '../format'
import { Icon } from './primitives/Icon'
import { usePresence } from '../hooks/usePresence'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const providerNames = {
  claude: 'Claude Code', codex: 'Codex', qoder: 'Qoder', opencode: 'OpenCode', pi: 'Pi', legacy_unknown: '历史 Provider 未知'
}

// Focus and pointer hover may belong to different rows. Ownership is shared so
// stale leave timers or a still-focused row can never render a second card.
type HoverClaim = { id: string; dismiss: () => void }
const HoverOwner = createContext<{
  claim: (next: HoverClaim) => void
  release: (id: string) => void
} | null>(null)

export function SessionHoverProvider({ children }: { children: ReactNode }) {
  const current = useRef<HoverClaim | null>(null)
  // Ownership is coordination, not list state. Only the previous card needs to close.
  const value = useMemo(() => ({
    claim(next: HoverClaim) {
      const previous = current.current
      current.current = next
      if (previous?.id !== next.id) previous?.dismiss()
    },
    release(id: string) {
      if (current.current?.id === id) current.current = null
    }
  }), [])
  return <HoverOwner.Provider value={value}>{children}</HoverOwner.Provider>
}

export function useSessionHoverCard(session: SessionMeta, cwd: string, projectName: string | undefined, running: boolean, runLabel = '正在运行') {
  const owner = useContext(HoverOwner)
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const frame = useRef<number>()
  const [visible, setOpen] = useState(false)
  const presence = usePresence({ onClose: () => setOpen(false), exitMs: 100 })
  const open = visible && owner !== null
  const [position, setPosition] = useState({ left: 0, top: 0, transformOrigin: 'top left' })
  const clear = (): void => {
    clearTimeout(timer.current)
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
  }
  const dismiss = (): void => { clear(); if (open) presence.requestClose('pointer') }
  const dismissImmediately = (): void => { clear(); presence.finishNow(); setOpen(false) }
  const show = (): void => { clear(); presence.reset(); setOpen(true) }
  const enter = (): void => {
    clear()
    setOpen(false)
    owner?.claim({ id, dismiss: dismissImmediately })
    timer.current = setTimeout(show, 350)
  }
  const leave = (): void => { clear(); timer.current = setTimeout(dismiss, 120) }
  const focus = (): void => {
    clear()
    setOpen(false)
    owner?.claim({ id, dismiss: dismissImmediately })
    // Let the browser scroll a keyboard-focused row into view before opening.
    frame.current = requestAnimationFrame(show)
  }
  useEffect(() => () => {
    clearTimeout(timer.current)
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    owner?.release(id)
  }, [owner, id])
  useBrowserLayoutEffect(() => {
    if (!open || !anchor.current || !card.current) return
    const row = anchor.current.getBoundingClientRect()
    const box = { width: card.current.offsetWidth, height: card.current.offsetHeight }
    const right = row.right + 8
    const showOnRight = right + box.width <= window.innerWidth - 8
    const left = showOnRight ? right : row.left - box.width - 8
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(row.top, window.innerHeight - box.height - 8)),
      transformOrigin: showOnRight ? 'top left' : 'top right'
    })
  }, [open, session.preview, projectName, cwd])
  useEffect(() => {
    if (!open) return
    const hide = (): void => { clearTimeout(timer.current); dismiss() }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') hide() }
    const scroll = (event: Event): void => {
      if (!(event.target instanceof Node) || !card.current?.contains(event.target)) hide()
    }
    const focus = (event: FocusEvent): void => { if (event.target !== anchor.current) hide() }
    window.addEventListener('resize', hide)
    document.addEventListener('scroll', scroll, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', key)
    document.addEventListener('focusin', focus)
    return () => {
      window.removeEventListener('resize', hide)
      document.removeEventListener('scroll', scroll, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', key)
      document.removeEventListener('focusin', focus)
    }
  }, [open])
  const validTime = Number.isFinite(session.mtime) && session.mtime > 0
  return {
    // A menu or selection takes ownership immediately; pointer leave / blur
    // still use the decorative exit above.
    dismiss: dismissImmediately,
    triggerProps: {
      ref: anchor,
      'aria-describedby': open && presence.state === 'enter' ? id : undefined,
      onMouseEnter: enter,
      onMouseLeave: leave,
      onFocus: focus,
      onBlur: dismiss
    },
    tooltip: open ? createPortal(
      <div id={id} ref={(node) => { card.current = node; presence.ref(node) }} role="tooltip" className="session-hover-card" data-state={presence.state} style={position}
        onMouseEnter={clear} onMouseLeave={dismiss}>
        <div className="session-hover-heading">
          <strong>{session.preview || '(无标题)'}</strong>
          <span className="session-hover-age">{validTime ? relTime(session.mtime) : '时间未知'}</span>
        </div>
        <div className="session-hover-project"><Icon name="folder" />
          <span className="session-hover-project-name">{cwd ? projectName || cwd.split('/').filter(Boolean).at(-1) || cwd : '未关联工作目录'}</span>
          <span className="session-hover-provider">{providerNames[session.providerId]}{running ? ` · ${runLabel}` : ''}</span>
        </div>
      </div>, document.body
    ) : null
  }
}
