import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionMeta } from '../env'
import { relTime } from '../format'
import { Icon } from './primitives/Icon'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const providerNames = {
  claude: 'Claude Code', codex: 'Codex', qoder: 'Qoder', opencode: 'OpenCode', pi: 'Pi', legacy_unknown: '历史 Provider 未知'
}

export function useSessionHoverCard(session: SessionMeta, cwd: string, projectName: string | undefined, running: boolean) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const frame = useRef<number>()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const clear = (): void => {
    clearTimeout(timer.current)
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
  }
  const dismiss = (): void => { clear(); setOpen(false) }
  const show = (): void => { clear(); setOpen(true) }
  const enter = (): void => { clear(); timer.current = setTimeout(show, 350) }
  const leave = (): void => { clear(); timer.current = setTimeout(() => setOpen(false), 120) }
  const focus = (): void => {
    clear()
    // Let the browser scroll a keyboard-focused row into view before opening.
    frame.current = requestAnimationFrame(show)
  }
  useEffect(() => () => {
    clearTimeout(timer.current)
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
  }, [])
  useBrowserLayoutEffect(() => {
    if (!open || !anchor.current || !card.current) return
    const row = anchor.current.getBoundingClientRect()
    const box = card.current.getBoundingClientRect()
    const right = row.right + 8
    const left = right + box.width <= window.innerWidth - 8 ? right : row.left - box.width - 8
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(row.top, window.innerHeight - box.height - 8))
    })
  }, [open, session.preview, projectName, cwd])
  useEffect(() => {
    if (!open) return
    const hide = (): void => { clearTimeout(timer.current); setOpen(false) }
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
  const absoluteTime = validTime ? new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(session.mtime) : '时间未知'
  return {
    dismiss,
    triggerProps: {
      ref: anchor,
      'aria-describedby': open ? id : undefined,
      onMouseEnter: enter,
      onMouseLeave: leave,
      onFocus: focus,
      onBlur: dismiss
    },
    tooltip: open ? createPortal(
      <div id={id} ref={card} role="tooltip" className="session-hover-card" style={position}
        onMouseEnter={clear} onMouseLeave={dismiss}>
        <div className="session-hover-heading">
          <strong>{session.preview || '(无标题)'}</strong>
          <span className="session-hover-age">{validTime ? relTime(session.mtime) : '时间未知'}</span>
        </div>
        <div className="session-hover-project"><Icon name="folder" />
          <span>{cwd ? projectName || cwd.split('/').filter(Boolean).at(-1) || cwd : '未关联工作目录'}</span>
        </div>
        {cwd && <div className="session-hover-path">{cwd}</div>}
        <div className="session-hover-details">
          <span>{providerNames[session.providerId]}{running ? ' · 正在运行' : ''}</span>
          <span>最近活动：{absoluteTime}</span>
        </div>
      </div>, document.body
    ) : null
  }
}
