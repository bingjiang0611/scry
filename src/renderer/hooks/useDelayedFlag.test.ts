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
    vi.advanceTimersByTime(250)
    expect(render(false)).toBe(false)
    vi.advanceTimersByTime(800)
    expect(render(false)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('becomes visible only after the full 300ms delay, without resetting on rerender', () => {
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(200)
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(99)
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(render(true)).toBe(true)
  })
  it('keeps a shown loader for at least 500ms, then hides it', () => {
    render(true); vi.advanceTimersByTime(300)
    expect(render(true)).toBe(true)
    vi.advanceTimersByTime(20)
    expect(render(false)).toBe(true)
    vi.advanceTimersByTime(479)
    expect(render(false)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(render(false)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('hides at once when the loader has already been up for its minimum', () => {
    render(true); vi.advanceTimersByTime(300)
    expect(render(true)).toBe(true)
    vi.advanceTimersByTime(900)
    expect(render(false)).toBe(true)
    vi.advanceTimersByTime(0)
    expect(render(false)).toBe(false)
  })
  it('stays shown, without a blink, when the next wait starts during the hold', () => {
    render(true); vi.advanceTimersByTime(300)
    expect(render(true)).toBe(true)
    expect(render(false)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(render(true)).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(render(true)).toBe(true)
  })
  it('starts a fresh delay when the previous loader never appeared', () => {
    render(true); vi.advanceTimersByTime(200)
    expect(render(false, undefined, false)).toBe(false)
    expect(render(true, undefined, false)).toBe(false)
    render(true); vi.advanceTimersByTime(299)
    expect(render(true)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(render(true)).toBe(true)
  })
  it('cancels the timer on unmount, without a late state write', () => {
    render(true)
    const writes = hooks.writes
    hooks.cleanup?.()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(800)
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
