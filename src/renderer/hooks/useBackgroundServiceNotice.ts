import { useEffect, useState } from 'react'
import type { BackgroundServiceRuntimeNotice } from '../../shared/background-service'
import { runtimeNoticeMessages } from '../constants/background-service-copy'

// Reads the current runtime notice on mount (without launching a lazy daemon) and
// subscribes to subsequent pushes, so notices emitted before this strip mounted are
// never missed (W2 review S4, P5 §2.2 & §2.4).
export function useBackgroundServiceNotice(): {
  messages: string[]
  dismiss: () => void
} {
  const [notice, setNotice] = useState<BackgroundServiceRuntimeNotice | null>(null)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let pushed = false
    const apply = (next: BackgroundServiceRuntimeNotice | null): void => {
      if (!active) return
      setNotice(next)
      setDismissedKey(null)
    }
    const read = window.scry?.backgroundServiceRuntimeNotice
    if (typeof read === 'function') {
      void read().then((initial) => { if (initial && !pushed) apply(initial) }, () => undefined)
    }
    const subscribe = window.scry?.onBackgroundServiceNotice
    const unsubscribe = typeof subscribe === 'function'
      ? subscribe((next) => { pushed = true; apply(next) })
      : undefined
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const messages = runtimeNoticeMessages(notice)
  const key = messages.join('\n')
  return {
    messages: key && key !== dismissedKey ? messages : [],
    dismiss: () => setDismissedKey(key)
  }
}
