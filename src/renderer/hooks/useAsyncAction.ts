import { useCallback, useEffect, useRef, useState } from 'react'

import { useDelayedFlag } from './useDelayedFlag'

export function actionErrorText(error: unknown, fallback = '操作失败'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const text = raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '').trim()
  return text || fallback
}

export type AsyncActionState<K extends string> = {
  /** The action in flight, if any. A second press of any action is ignored until it settles. */
  pending: K | null
  showBusy: boolean
  /** The last failure, shown where the person acted; cleared by the next run. */
  error: { key: K; text: string } | null
  run: (key: K, action: () => Promise<void>) => void
  retry: () => void
  clearError: () => void
}

export function useAsyncAction<K extends string>(describe: (error: unknown) => string = actionErrorText): AsyncActionState<K> {
  const [pending, setPending] = useState<K | null>(null)
  const [error, setError] = useState<{ key: K; text: string } | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const last = useRef<{ key: K; action: () => Promise<void> } | null>(null)
  const describeRef = useRef(describe)
  describeRef.current = describe
  useEffect(() => () => { mounted.current = false }, [])
  const run = useCallback((key: K, action: () => Promise<void>): void => {
    if (inFlight.current) return
    inFlight.current = true
    last.current = { key, action }
    setPending(key)
    setError(null)
    void action().then(() => {
      if (mounted.current) last.current = null
    }, (cause: unknown) => {
      if (mounted.current) setError({ key, text: describeRef.current(cause) })
    }).finally(() => {
      inFlight.current = false
      if (mounted.current) setPending(null)
    })
  }, [])
  const retry = useCallback((): void => {
    const previous = last.current
    if (previous) run(previous.key, previous.action)
  }, [run])
  const clearError = useCallback((): void => setError(null), [])
  const showBusy = useDelayedFlag(pending !== null)
  return { pending, showBusy, error, run, retry, clearError }
}
