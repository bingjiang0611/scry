import { useEffect, useState } from 'react'
import type { BackgroundServiceRuntimeNotice } from '../../shared/background-service'
import { runtimeNoticeMessages } from '../constants/background-service-copy'

// Subscribes to non-silent background-service runtime notices (service-manager launch
// fallback or adopted service-launched daemon policy mismatch; P5 §2.2, §2.4).
export function useBackgroundServiceNotice(): {
  messages: string[]
  dismiss: () => void
} {
  const [notice, setNotice] = useState<BackgroundServiceRuntimeNotice | null>(null)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  useEffect(() => {
    const subscribe = window.scry?.onBackgroundServiceNotice
    if (typeof subscribe !== 'function') return
    return subscribe((next) => {
      setNotice(next)
      setDismissedKey(null)
    })
  }, [])

  const messages = runtimeNoticeMessages(notice)
  const key = messages.join('\n')
  return {
    messages: key && key !== dismissedKey ? messages : [],
    dismiss: () => setDismissedKey(key)
  }
}
