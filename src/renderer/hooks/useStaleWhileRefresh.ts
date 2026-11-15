import { useCallback, useEffect, useReducer, useRef } from 'react'

import { actionErrorText } from './useAsyncAction'

/**
 * Keep what is known while it is read again.
 *
 * The cache key must name every input that changes the answer (cwd, provider,
 * profile, range, cursor...). Data belongs to exactly one key: after a key change
 * the previous answer is not shown as the new one, so `data` is empty and the
 * status is `loading` until the new key answers. A refresh of the same key keeps
 * the previous answer on screen with `refreshing`, and its `fetchedAt` says how
 * old it is. A failed refresh keeps that answer and reports the failure next to it.
 */
export type StaleStatus = 'loading' | 'refreshing' | 'ready' | 'error'

export type StaleSnapshot<T> = {
  key: string
  data: T | undefined
  fetchedAt: number | undefined
  error: string | null
  inFlight: boolean
}

export type StaleAction<T> =
  | { type: 'start'; key: string }
  | { type: 'resolve'; key: string; data: T; at: number }
  | { type: 'reject'; key: string; error: string }

export function staleReducer<T>(state: StaleSnapshot<T>, action: StaleAction<T>): StaleSnapshot<T> {
  switch (action.type) {
    case 'start':
      return action.key === state.key
        ? { ...state, inFlight: true, error: null }
        : { key: action.key, data: undefined, fetchedAt: undefined, error: null, inFlight: true }
    case 'resolve':
      return action.key === state.key ? { key: state.key, data: action.data, fetchedAt: action.at, error: null, inFlight: false } : state
    case 'reject':
      return action.key === state.key ? { ...state, error: action.error, inFlight: false } : state
  }
}

export function staleStatus<T>(state: StaleSnapshot<T>): StaleStatus {
  if (state.inFlight) return state.data === undefined ? 'loading' : 'refreshing'
  if (state.data === undefined) return state.error ? 'error' : 'loading'
  return 'ready'
}

export type StaleWhileRefresh<T> = {
  data: T | undefined
  status: StaleStatus
  error: string | null
  fetchedAt: number | undefined
  /** Reads the same key again. A refresh during a read joins it and runs once after. */
  refresh: () => void
}

export function useStaleWhileRefresh<T>(key: string, load: (key: string) => Promise<T>): StaleWhileRefresh<T> {
  const [state, dispatch] = useReducer(staleReducer<T>, { key, data: undefined, fetchedAt: undefined, error: null, inFlight: false })
  const loadRef = useRef(load)
  loadRef.current = load
  const running = useRef<string | null>(null)
  const again = useRef(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const read = useCallback((target: string): void => {
    // One request per key at a time; a burst of refreshes becomes one more read.
    if (running.current === target) { again.current = true; return }
    running.current = target
    again.current = false
    dispatch({ type: 'start', key: target })
    void loadRef.current(target).then(
      (data) => { if (mounted.current) dispatch({ type: 'resolve', key: target, data, at: Date.now() }) },
      (cause: unknown) => { if (mounted.current) dispatch({ type: 'reject', key: target, error: actionErrorText(cause, '读取失败') }) }
    ).finally(() => {
      if (running.current !== target) return
      running.current = null
      if (again.current && mounted.current) read(target)
    })
  }, [])

  useEffect(() => { read(key) }, [key, read])
  const refresh = useCallback((): void => read(key), [key, read])
  const current = state.key === key ? state : { ...state, key, data: undefined, fetchedAt: undefined, error: null, inFlight: true }
  return { data: current.data, status: staleStatus(current), error: current.error, fetchedAt: current.fetchedAt, refresh }
}
