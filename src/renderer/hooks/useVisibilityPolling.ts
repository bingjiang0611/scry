import { useEffect, useRef } from 'react'

type TimerHandle = number
export interface VisibilityPollingEnvironment {
  isHidden: () => boolean
  addVisibilityListener: (listener: () => void) => void
  removeVisibilityListener: (listener: () => void) => void
  setInterval: (callback: () => void, delay: number) => TimerHandle
  clearInterval: (timer: TimerHandle) => void
}
const browserEnvironment = (): VisibilityPollingEnvironment => ({
  isHidden: () => document.hidden,
  addVisibilityListener: listener => document.addEventListener('visibilitychange', listener),
  removeVisibilityListener: listener => document.removeEventListener('visibilitychange', listener),
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: timer => window.clearInterval(timer)
})

export function createVisibilityPollingController(
  refresh: () => Promise<void> | void,
  intervalMs: number,
  environment: VisibilityPollingEnvironment = browserEnvironment(),
  invalidate: () => void = () => {}
) {
  let timer: TimerHandle | undefined
  let inFlight: Promise<void> | undefined
  let started = false
  let pendingRefresh = false
  let delay = intervalMs
  const clearTimer = (): void => {
    if (timer === undefined) return
    environment.clearInterval(timer)
    timer = undefined
  }
  const requestRefresh = (queueIfBusy = false): void => {
    if (!started || environment.isHidden()) return
    if (inFlight) { pendingRefresh ||= queueIfBusy; return }
    let request: Promise<void>
    try { request = Promise.resolve(refresh()) } catch (error) { request = Promise.reject(error) }
    inFlight = request
    const settled = (): void => {
      inFlight = undefined
      if (!pendingRefresh) return
      pendingRefresh = false
      requestRefresh()
    }
    // Callers own loading/error projection. A rejected read still releases the
    // scheduler; it is never interpreted as successful evidence here.
    void request.then(settled, settled)
  }
  const schedule = (): void => {
    if (!started || environment.isHidden() || timer !== undefined) return
    timer = environment.setInterval(() => requestRefresh(), delay)
  }
  const changed = (): void => {
    invalidate()
    if (environment.isHidden()) clearTimer()
    else { schedule(); requestRefresh(true) }
  }
  return {
    setIntervalMs: (value: number): void => {
      if (value === delay) return
      delay = value
      clearTimer()
      schedule()
    },
    start: (): void => {
      if (started) return
      started = true
      environment.addVisibilityListener(changed)
      changed()
    },
    stop: (): void => {
      started = false
      pendingRefresh = false
      clearTimer()
      environment.removeVisibilityListener(changed)
    }
  }
}

// Per-mounted-owner controller: no registry of session keys or retained closures.
// Shared stores subscribe once at their own boundary instead of sharing React effects.
// Returns the controller's interval setter so an owner can back off from poll
// results without a React state change (and therefore without a re-render).
export function useVisibilityPolling(
  key: string,
  refresh: () => Promise<void> | void,
  intervalMs: number,
  invalidate: () => void = () => {}
): (intervalMs: number) => void {
  const refreshRef = useRef(refresh)
  const invalidateRef = useRef(invalidate)
  refreshRef.current = refresh
  invalidateRef.current = invalidate
  const controllerRef = useRef<ReturnType<typeof createVisibilityPollingController> | undefined>(undefined)
  controllerRef.current ??= createVisibilityPollingController(() => refreshRef.current(), intervalMs, undefined, () => invalidateRef.current())
  const controller = controllerRef.current
  useEffect(() => {
    controller.setIntervalMs(intervalMs)
    controller.start()
    return () => controller.stop()
  }, [controller, intervalMs, key])
  return controller.setIntervalMs
}
