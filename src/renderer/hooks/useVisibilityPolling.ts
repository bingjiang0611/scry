import { useEffect, useRef } from 'react'

type TimerHandle = number

export interface VisibilityPollingEnvironment {
  isHidden: () => boolean
  addVisibilityListener: (listener: () => void) => void
  removeVisibilityListener: (listener: () => void) => void
  setInterval: (callback: () => void, delay: number) => TimerHandle
  clearInterval: (timer: TimerHandle) => void
}

function browserEnvironment(): VisibilityPollingEnvironment {
  return {
    isHidden: () => typeof document !== 'undefined' && document.hidden,
    addVisibilityListener: (listener) => document.addEventListener('visibilitychange', listener),
    removeVisibilityListener: (listener) => document.removeEventListener('visibilitychange', listener),
    setInterval: (callback, delay) => window.setInterval(callback, delay),
    clearInterval: (timer) => window.clearInterval(timer)
  }
}

export interface VisibilityPollingController {
  setIntervalMs: (intervalMs: number) => void
  start: () => void
  stop: () => void
  dispose: () => void
}

export function createVisibilityPollingController(
  refresh: () => Promise<void> | void,
  intervalMs: number,
  environment: VisibilityPollingEnvironment = browserEnvironment()
): VisibilityPollingController {
  let timer: TimerHandle | undefined
  let inFlight: Promise<void> | undefined
  let started = false
  let delay = intervalMs

  const clearTimer = (): void => {
    if (timer === undefined) return
    environment.clearInterval(timer)
    timer = undefined
  }
  const refreshIfVisible = (): void => {
    if (!started || environment.isHidden() || inFlight) return
    let request: Promise<void>
    try {
      request = Promise.resolve(refresh())
    } catch (error) {
      request = Promise.reject(error)
    }
    inFlight = request
    void request.then(
      () => { if (inFlight === request) inFlight = undefined },
      () => { if (inFlight === request) inFlight = undefined }
    )
  }
  const schedule = (): void => {
    if (!started || environment.isHidden() || timer !== undefined) return
    timer = environment.setInterval(refreshIfVisible, delay)
  }
  const onVisibilityChange = (): void => {
    if (!started) return
    if (environment.isHidden()) clearTimer()
    else {
      schedule()
      refreshIfVisible()
    }
  }

  return {
    setIntervalMs: (intervalMs) => {
      if (delay === intervalMs) return
      delay = intervalMs
      if (started) {
        clearTimer()
        schedule()
      }
    },
    start: () => {
      if (started) return
      started = true
      environment.addVisibilityListener(onVisibilityChange)
      schedule()
      refreshIfVisible()
    },
    stop: () => {
      if (!started) return
      started = false
      clearTimer()
      environment.removeVisibilityListener(onVisibilityChange)
    },
    dispose: () => {
      started = false
      clearTimer()
      environment.removeVisibilityListener(onVisibilityChange)
    }
  }
}

type SharedEntry = {
  controller: VisibilityPollingController
  refs: number
  refresh: () => Promise<void> | void
}
const sharedEntries = new Map<string, SharedEntry>()

export function useVisibilityPolling(key: string, refresh: () => Promise<void> | void, intervalMs: number): void {
  const refreshRef = useRef<() => Promise<void> | void>(refresh)
  refreshRef.current = refresh
  const entryRef = useRef<SharedEntry | undefined>(undefined)
  const keyRef = useRef(key)
  if (!entryRef.current || keyRef.current !== key) {
    keyRef.current = key
    const entry = sharedEntries.get(key) ?? (() => {
      const next: SharedEntry = { refresh: () => {}, refs: 0, controller: undefined as never }
      next.controller = createVisibilityPollingController(() => next.refresh(), intervalMs)
      sharedEntries.set(key, next)
      return next
    })()
    entryRef.current = entry
  }
  const entry = entryRef.current
  if (!entry) return
  entry.refresh = () => refreshRef.current()

  useEffect(() => {
    entry.controller.setIntervalMs(intervalMs)
    entry.refs += 1
    if (entry.refs === 1) entry.controller.start()
    return () => {
      entry.refs -= 1
      if (entry.refs === 0) entry.controller.stop()
    }
  }, [entry, intervalMs])
}
