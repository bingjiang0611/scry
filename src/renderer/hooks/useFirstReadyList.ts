import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { MOTION, subscribeReducedMotion } from '../motion'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function useFirstReadyList(ready: boolean) {
  const started = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const [active, setActive] = useState(ready)
  useBrowserLayoutEffect(() => {
    if (!ready) {
      if (started.current) { clearTimeout(timer.current); setActive(false) }
      return
    }
    if (started.current) return
    started.current = true
    setActive(true)
    timer.current = setTimeout(() => setActive(false), MOTION.durBase + 10 * 16)
  }, [ready])
  useEffect(() => {
    if (!active) return
    const cancel = (): void => setActive(false)
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancel, true)
    return () => { document.removeEventListener('pointerdown', cancel, true); document.removeEventListener('keydown', cancel, true) }
  }, [active])
  useEffect(() => {
    const unsubscribe = subscribeReducedMotion(() => setActive(false))
    return () => { unsubscribe(); clearTimeout(timer.current) }
  }, [])
  return {
    className: active && ready ? 'motion-stagger' : '',
    itemStyle: (index: number): CSSProperties | undefined => index < 10 ? { '--i': index } as CSSProperties : undefined
  }
}
