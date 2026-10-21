import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeUiPointer } from './native-ui-pointer.mjs'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture(endTime) {
  vi.useFakeTimers()
  const frames = []
  let left = 0
  const animation = { pending: true, playState: 'running', effect: { getComputedTiming: () => ({ endTime }) } }
  const element = { getBoundingClientRect: () => ({ x: left, y: 0, left, top: 0, width: 40, height: 40 }),
    contains: () => true, getAnimations: () => [animation], parentElement: null }
  vi.stubGlobal('document', { querySelector: () => element, elementFromPoint: () => element, getAnimations: () => [animation] })
  vi.stubGlobal('requestAnimationFrame', callback => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  return { animation, element, move: value => { left = value }, frame: async () => { frames.shift()(); await Promise.resolve() } }
}

describe('native pointer readiness', () => {
  it('does not dispatch at temporarily stable geometry before a finite transition moves the control', async () => {
    const f = fixture(150)
    let result
    const pending = nativeUiPointer('.location-button', { timeoutMs: 7000, scroll: false, captureReceipt: false })
      .then(value => { result = value })
    await f.frame(); await f.frame()
    expect(result).toBeUndefined()
    f.animation.pending = false; f.animation.playState = 'finished'; f.move(100)
    await f.frame(); await f.frame()
    await pending
    expect(result).toEqual({ x: 120, y: 20 })
  })
  it('does not wait for unrelated finite animations elsewhere on the page', async () => {
    const f = fixture(150)
    f.element.getAnimations = () => []
    const pending = nativeUiPointer('.location-button', { timeoutMs: 7000, scroll: false, captureReceipt: false })
    await f.frame(); await f.frame()
    await expect(pending).resolves.toEqual({ x: 20, y: 20 })
  })
  it('ignores infinite activity animations rather than blocking ordinary controls forever', async () => {
    const f = fixture(Infinity)
    const pending = nativeUiPointer('.location-button', { timeoutMs: 7000, scroll: false, captureReceipt: false })
    await f.frame(); await f.frame()
    await expect(pending).resolves.toEqual({ x: 20, y: 20 })
  })
})
