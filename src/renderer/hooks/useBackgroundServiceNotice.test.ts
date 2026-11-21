import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundServiceRuntimeNotice } from '../../shared/background-service'
import { useBackgroundServiceNotice } from './useBackgroundServiceNotice'

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  effectRan: false,
  pending: undefined as (() => void | (() => void)) | undefined,
  cleanup: undefined as (() => void) | undefined
}))

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const slot = hooks.index++
    if (!(slot in hooks.states)) {
      hooks.states[slot] = typeof initial === 'function' ? initial() : initial
    }
    return [hooks.states[slot], (value: unknown) => {
      hooks.states[slot] = typeof value === 'function' ? value(hooks.states[slot]) : value
    }]
  },
  useEffect: (effect: () => void | (() => void)) => {
    if (!hooks.effectRan) {
      hooks.effectRan = true
      hooks.pending = effect
    }
  }
}))

function renderHook() {
  hooks.index = 0
  const result = useBackgroundServiceNotice()
  if (hooks.pending) {
    hooks.cleanup = hooks.pending() || undefined
    hooks.pending = undefined
  }
  return result
}

const originalWindow = (globalThis as { window?: unknown }).window

beforeEach(() => {
  hooks.states = []
  hooks.index = 0
  hooks.effectRan = false
  hooks.pending = undefined
  hooks.cleanup = undefined
})

afterEach(() => {
  hooks.cleanup?.()
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window
  } else {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

describe('useBackgroundServiceNotice (W2 S4)', () => {
  it('loads a notice already recorded before mount via backgroundServiceRuntimeNotice', async () => {
    const initial: BackgroundServiceRuntimeNotice = {
      serviceLaunchFallback: { reason: 'login_start_service_launch_failed', exitCode: 113 }
    }
    const read = vi.fn().mockResolvedValue(initial)
    const unsubscribe = vi.fn()
    const subscribe = vi.fn().mockReturnValue(unsubscribe)
    ;(globalThis as { window?: unknown }).window = {
      scry: { backgroundServiceRuntimeNotice: read, onBackgroundServiceNotice: subscribe }
    }

    expect(renderHook().messages).toEqual([])
    expect(read).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    const loaded = renderHook()
    expect(loaded.messages.length).toBe(1)
    expect(loaded.messages[0]).toContain('login_start_service_launch_failed')

    loaded.dismiss()
    expect(renderHook().messages).toEqual([])
    hooks.cleanup?.()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not let a late initial read overwrite a newer push event', async () => {
    let resolveInitial!: (notice: BackgroundServiceRuntimeNotice | null) => void
    const read = vi.fn().mockReturnValue(new Promise<BackgroundServiceRuntimeNotice | null>((resolve) => {
      resolveInitial = resolve
    }))
    let listener: ((notice: BackgroundServiceRuntimeNotice) => void) | undefined
    const subscribe = vi.fn((cb: (notice: BackgroundServiceRuntimeNotice) => void) => {
      listener = cb
      return () => {}
    })
    ;(globalThis as { window?: unknown }).window = {
      scry: { backgroundServiceRuntimeNotice: read, onBackgroundServiceNotice: subscribe }
    }

    renderHook()
    listener?.({ serviceLaunchFallback: { reason: 'daemon_ready_timeout' } })
    resolveInitial({ serviceLaunchFallback: { reason: 'login_start_service_launch_failed', exitCode: 113 } })
    await Promise.resolve()

    const messages = renderHook().messages
    expect(messages.length).toBe(1)
    expect(messages[0]).toContain('daemon_ready_timeout')
  })
})
