import { useEffect, useRef, useState } from 'react'
import { isStickyNotice, NOTICE_DURATION_MS, type BackgroundNotice, type BackgroundNoticeKind } from '../background-notices'
import { BACKGROUND_NOTICE_COPY as copy } from '../constants/copy'
import { Icon } from './primitives/Icon'
import { IconButton } from './primitives/IconButton'
import './background-notices.css'

const ICONS: Record<BackgroundNoticeKind, Parameters<typeof Icon>[0]['name']> = {
  attention: 'message',
  failed: 'alert',
  interrupted: 'alert',
  cancelled: 'square',
  completed: 'check',
  updated: 'info'
}

/**
 * Notices for sessions the user is not looking at, in the sidebar above the settings footer
 * (at most three; the activity view keeps the history).
 * Needs-a-reply, failed and interrupted notices stay until opened, dismissed or read;
 * the others leave after NOTICE_DURATION_MS, and the countdown pauses while the pointer
 * or focus is inside the region or the window is in the background. Notices never take
 * focus. Nothing is rendered while there is nothing to say, so no empty live region exists.
 */
export function BackgroundNotices({ notices, onOpen, onDismiss }: {
  notices: readonly BackgroundNotice[]
  onOpen: (notice: BackgroundNotice) => void
  onDismiss: (key: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [windowActive, setWindowActive] = useState(() => typeof document === 'undefined' || document.hasFocus())
  const remaining = useRef(new Map<string, number>())
  useEffect(() => {
    const active = (): void => setWindowActive(true)
    const inactive = (): void => setWindowActive(false)
    window.addEventListener('focus', active)
    window.addEventListener('blur', inactive)
    return () => {
      window.removeEventListener('focus', active)
      window.removeEventListener('blur', inactive)
    }
  }, [])
  // The region unmounts when empty, so it cannot report the pointer or focus leaving.
  useEffect(() => {
    if (notices.length > 0) return
    setHovered(false)
    setFocused(false)
  }, [notices.length])
  const paused = hovered || focused || !windowActive
  useEffect(() => {
    const timed = notices.filter((notice) => !isStickyNotice(notice.kind))
    for (const notice of timed) if (!remaining.current.has(notice.key)) remaining.current.set(notice.key, NOTICE_DURATION_MS)
    for (const key of [...remaining.current.keys()]) if (!timed.some((notice) => notice.key === key)) remaining.current.delete(key)
    if (paused || timed.length === 0) return
    let last = Date.now()
    const timer = window.setInterval(() => {
      const now = Date.now()
      const elapsed = now - last
      last = now
      for (const notice of timed) {
        const left = (remaining.current.get(notice.key) ?? 0) - elapsed
        remaining.current.set(notice.key, left)
        if (left <= 0) onDismiss(notice.key)
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [notices, paused, onDismiss])
  if (notices.length === 0) return null
  return <section className="background-notices" aria-label={copy.region}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
    {notices.map((notice) => {
      const title = notice.title.trim() || copy.untitled
      return <article key={notice.key} className="background-notice" data-kind={notice.kind}
        role={isStickyNotice(notice.kind) ? 'alert' : 'status'}>
        <button type="button" className="background-notice-open" title={copy.open(title)} onClick={() => onOpen(notice)}>
          <Icon name={ICONS[notice.kind]} className="background-notice-icon" />
          <b>{copy.kind[notice.kind]}</b>
          <span className="background-notice-title">{title}</span>
          <small>{notice.projectName}</small>
        </button>
        <IconButton size="sm" label={copy.dismiss(title)} onClick={() => onDismiss(notice.key)}><Icon name="x" /></IconButton>
      </article>
    })}
  </section>
}
