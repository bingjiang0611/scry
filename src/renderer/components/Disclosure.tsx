import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { usePresence } from '../hooks/usePresence'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function useDisclosurePresence(open: boolean) {
  const [present, setPresent] = useState(open)
  const latestOpen = useRef(open)
  latestOpen.current = open
  const presence = usePresence({ exitMs: 160, onClose: () => { if (!latestOpen.current) setPresent(false) } })
  useBrowserLayoutEffect(() => {
    if (open) { presence.reset(); setPresent(true) }
    else if (present) presence.requestClose('replace')
  }, [open])
  return { ...presence, present }
}

export function disclosureIsLong(node: HTMLElement): boolean {
  const style = getComputedStyle(node)
  // `normal` has no numeric computed line height; font size is a conservative
  // height budget rather than guessing the platform's font metrics.
  const lineHeight = Number.parseFloat(style.lineHeight === 'normal' ? style.fontSize : style.lineHeight)
  return node.scrollHeight > lineHeight * 40
}

export function Disclosure({ open, long = false, immediate = false, children }: {
  open: boolean
  long?: boolean
  immediate?: boolean
  children: () => ReactNode
}) {
  const presence = useDisclosurePresence(open)
  const initiallyOpen = useRef(open)
  const immediateEntrance = useRef(immediate)
  if (!open) {
    initiallyOpen.current = false
    immediateEntrance.current = false
  }
  else if (immediate) immediateEntrance.current = true
  const content = useRef<HTMLDivElement>(null)
  const [measuredLong, setMeasuredLong] = useState(long)
  useBrowserLayoutEffect(() => {
    if (open && presence.present && content.current) setMeasuredLong(long || disclosureIsLong(content.current))
  }, [open, presence.present, long])
  if (!presence.present) return null
  return <div className="motion-disclosure" data-state={open ? 'enter' : 'exit'} data-long={long || measuredLong || undefined} data-immediate={open && (initiallyOpen.current || immediateEntrance.current) || undefined}
    aria-hidden={!open || undefined} ref={node => { presence.ref(node); if (node) node.inert = !open }}>
    <div className="motion-disclosure-inner" ref={content}>{children()}</div>
  </div>
}
