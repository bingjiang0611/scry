import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDelayedFlag } from './useDelayedFlag'

const hooks = vi.hoisted(() => ({
  state: undefined as unknown,
  deps: undefined as readonly unknown[] | undefined,
  cleanup: undefined as (() => void) | undefined,
  pending: undefined as (() => void | (() => void)) | undefined,
  writes: 0, renderWrites: 0
}))
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    if (hooks.state === undefined) hooks.state = typeof initial === 'function' ? initial() : initial
    return [hooks.state, (value: unknown) => {
      const next = typeof value === 'function' ? value(hooks.state) : value
      if (next !== hooks.state) { hooks.state = next; hooks.writes++; hooks.renderWrites++ }
    }]
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    if (!hooks.deps || deps.some((value, i) => value !== hooks.deps![i])) { hooks.deps = deps; hooks.pending = effect }
  }
}))
function render(flag: boolean, delay?: number, flushEffects = true): boolean {
  let result: boolean
  // React retries own-component render-phase state adjustments before committing.
  do { hooks.renderWrites = 0; result = useDelayedFlag(flag, delay) } while (hooks.renderWrites)
  if (flushEffects && hooks.pending) {
    hooks.cleanup?.(); hooks.cleanup = hooks.pending() || undefined; hooks.pending = undefined
  }
  return result
}
beforeEach(() => {
  vi.useFakeTimers()
  hooks.state = undefined; hooks.deps = undefined; hooks.cleanup = undefined; hooks.pending = undefined; hooks.writes = 0
})
afterEach(() => { hooks.cleanup?.(); vi.useRealTimers() })

describe('useDelayedFlag', () => {
  it('never becomes visible for a short request', () => {
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(60)
    expect(render(false)).toBe(false)
    vi.advanceTimersByTime(400)
    expect(render(false)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('becomes visible only after the full delay, without resetting on rerender', () => {
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(100)
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(49)
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(render(true)).toBe(true)
  })
  it('returns false on the same render that flag becomes false', () => {
    render(true); vi.advanceTimersByTime(150)
    expect(render(true)).toBe(true)
    expect(render(false)).toBe(false)
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(149)
    expect(render(true)).toBe(false)
  })
  it('cannot reuse previous visibility before passive effects flush in a new cycle', () => {
    render(true); vi.advanceTimersByTime(150)
    expect(render(true)).toBe(true)
    expect(render(false, undefined, false)).toBe(false)
    expect(render(true, undefined, false)).toBe(false)
    render(true); vi.advanceTimersByTime(149)
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(render(true)).toBe(true)
  })
  it('cancels the timer on unmount, without a late state write', () => {
    render(true)
    const writes = hooks.writes
    hooks.cleanup?.()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(400)
    expect(hooks.writes).toBe(writes)
  })
  it('supports an explicit delay and cancels superseded pending timers', () => {
    render(true, 80); vi.advanceTimersByTime(40)
    render(true, 200)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(199)
    expect(render(true, 200)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(render(true, 200)).toBe(true)
  })
})
