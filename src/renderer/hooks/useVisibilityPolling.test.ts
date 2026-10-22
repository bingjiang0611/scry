import { describe, expect, it, vi } from 'vitest'
import { createVisibilityPollingController, type VisibilityPollingEnvironment } from './useVisibilityPolling'

function testEnvironment(hidden = false): VisibilityPollingEnvironment & { setHidden: (value: boolean) => void; tick: () => void } {
  const listeners = new Set<() => void>()
  let interval: (() => void) | undefined
  let isHidden = hidden
  return {
    isHidden: () => isHidden,
    addVisibilityListener: listener => { listeners.add(listener) },
    removeVisibilityListener: listener => { listeners.delete(listener) },
    setInterval: callback => { interval = callback; return 1 },
    clearInterval: () => { interval = undefined },
    setHidden: value => { isHidden = value; for (const listener of listeners) listener() },
    tick: () => interval?.()
  }
}

describe('visibility polling', () => {
  it('pauses hidden timers and refreshes immediately when visible', () => {
    const environment = testEnvironment(true)
    const refresh = vi.fn()
    const controller = createVisibilityPollingController(refresh, 3000, environment)

    controller.start()
    expect(refresh).not.toHaveBeenCalled()
    environment.setHidden(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    environment.tick()
    expect(refresh).toHaveBeenCalledTimes(1)
    controller.stop()
  })

  it('keeps one request across effect-style stop/start while it is pending', async () => {
    const environment = testEnvironment()
    let resolve!: () => void
    const refresh = vi.fn(() => new Promise<void>(done => { resolve = done }))
    const controller = createVisibilityPollingController(refresh, 3000, environment)

    controller.start()
    controller.stop()
    controller.start()
    environment.tick()
    expect(refresh).toHaveBeenCalledTimes(1)

    resolve()
    await Promise.resolve()
    environment.tick()
    expect(refresh).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('releases the single-flight guard after a failed refresh', async () => {
    const environment = testEnvironment()
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)
    const controller = createVisibilityPollingController(refresh, 3000, environment)

    controller.start()
    await Promise.resolve()
    environment.tick()
    expect(refresh).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
})
