import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

// Keep an entrance flag through token-only renders, then retire it. The extra
// 80ms is cleanup slack for the first compositor frame, not animation duration.
export function useLiveArrivalKeys(keys: readonly string[], eligible: boolean, resetKey: unknown): ReadonlySet<string> {
  const seen = useRef(new Set<string>())
  const previousKeys = useRef<readonly string[]>()
  const active = useRef(new Map<string, number>())
  const initialized = useRef(false)
  const previousReset = useRef(resetKey)
  const previouslyEligible = useRef(false)
  const [epoch, setEpoch] = useState(0)
  const now = performance.now()
  const reset = !initialized.current || previousReset.current !== resetKey || eligible && !previouslyEligible.current
  const currentKeys = useMemo(() => new Set(keys), [keys])
  const next = reset ? new Map<string, number>() : new Map([...active.current].filter(([key, deadline]) => deadline > now && currentKeys.has(key)))
  if (!reset && eligible && previousKeys.current !== keys) for (const key of keys) if (!seen.current.has(key)) next.set(key, now + 260)
  useBrowserLayoutEffect(() => {
    initialized.current = true
    previousReset.current = resetKey
    previouslyEligible.current = eligible
    seen.current = currentKeys
    previousKeys.current = keys
    active.current = next
    if (!next.size) return
    const timer = setTimeout(() => setEpoch(value => value + 1), Math.min(...next.values()) - now)
    return () => clearTimeout(timer)
  }, [keys, eligible, resetKey, epoch])
  return new Set(next.keys())
}
