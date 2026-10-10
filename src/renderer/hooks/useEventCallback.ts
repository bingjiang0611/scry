import { useCallback, useLayoutEffect, useRef } from 'react'

/** Stable event identity without freezing the state read by the handler. */
export function useEventCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback)
  useLayoutEffect(() => { latest.current = callback })
  return useCallback((...args: Args) => latest.current(...args), [])
}
