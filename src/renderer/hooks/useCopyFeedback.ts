import { useCallback, useEffect, useRef, useState } from 'react'

import { actionErrorText } from './useAsyncAction'

export const COPIED_FEEDBACK_MS = 2_000

export type CopyStatus = { state: 'idle' } | { state: 'copied' } | { state: 'failed'; reason: string }

/**
 * Feedback for a copy whose result is not visible where the person looks: the
 * button's icon turns into a check for a moment and a polite status says it
 * copied. A failure is kept, with its reason, until the next attempt.
 */
export function useCopyFeedback(): { status: CopyStatus; copy: (text: string) => void } {
  const [status, setStatus] = useState<CopyStatus>({ state: 'idle' })
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => {
    if (status.state !== 'copied') return
    const timer = setTimeout(() => setStatus((current) => current === status ? { state: 'idle' } : current), COPIED_FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [status])
  const copy = useCallback((text: string): void => {
    void window.scry.copyText(text).then(
      () => { if (mounted.current) setStatus({ state: 'copied' }) },
      (error: unknown) => { if (mounted.current) setStatus({ state: 'failed', reason: actionErrorText(error, '复制失败') }) }
    )
  }, [])
  return { status, copy }
}
