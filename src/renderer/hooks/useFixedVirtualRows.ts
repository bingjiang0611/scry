import { useEffect, useRef, useState } from 'react'

/** Fixed-height diff lines and file rows: bound DOM work, including before the first measurement. */
export function useFixedVirtualRows(count: number, rowHeight: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 480 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const top = element.scrollTop
      const height = element.clientHeight
      setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height })
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    element.addEventListener('scroll', schedule, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [count, rowHeight])
  const visible = Math.ceil((viewport.height || 480) / rowHeight) + 16
  const start = Math.min(Math.max(0, Math.floor(viewport.top / rowHeight) - 8), Math.max(0, count - visible))
  const end = Math.min(count, start + visible)
  const reveal = (index: number): void => {
    const element = ref.current
    if (!element) return
    const top = index * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight
    }
    element.focus()
  }
  return { ref, start, end, totalHeight: count * rowHeight, offset: start * rowHeight, reveal }
}
