import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureNativeSessionOpen } from './session-open-timing.mjs'

let frames
let nextId
const advanceFrame = () => {
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach(callback => callback())
}

beforeEach(() => {
  frames = new Map()
  nextId = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('requestAnimationFrame', callback => {
    frames.set(++nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native session-open clock', () => {
  it('starts at the click event and requires two consecutive ready frames', async () => {
    const button = new EventTarget()
    const pending = measureNativeSessionOpen(button, () => true)
    expect(frames.size).toBe(0)
    let settled = false
    pending.then(() => { settled = true })
    const event = new Event('click')
    button.dispatchEvent(event)
    advanceFrame()
    await Promise.resolve()
    expect(settled).toBe(false)
    advanceFrame()
    const result = await pending
    expect(result.clickAt).toBe(event.timeStamp)
    expect(result.readyAt).toBeGreaterThanOrEqual(result.clickAt)
    expect(result.nativeOpenMs).toBe(result.readyAt - result.clickAt)
    expect(result.trustedClick).toBe(false) // Synthetic test input must not masquerade as native.
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    button.dispatchEvent(new Event('click'))
    expect(frames.size).toBe(0)
  })

  it('excludes setup and delayed driver readback, but includes event queueing', async () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const button = new EventTarget()
    const pending = measureNativeSessionOpen(button, () => true)
    const event = new Event('click')
    Object.defineProperty(event, 'timeStamp', { value: 180 })
    now = 200
    button.dispatchEvent(event)
    now = 210
    advanceFrame()
    now = 220
    advanceFrame()
    now = 5000 // The driver can read the resolved sample much later.
    const result = await pending
    expect(result.nativeOpenMs).toBe(40)
    expect(result.handlerDelayMs).toBe(20)
    expect(result.readyAt).toBe(220)
  })

  it('resets stability when readiness is lost, rather than accumulating two ready frames', async () => {
    const button = new EventTarget()
    let ready = true
    let settled = false
    const pending = measureNativeSessionOpen(button, () => ready)
    pending.then(() => { settled = true })
    button.dispatchEvent(new Event('click'))
    advanceFrame()
    ready = false
    advanceFrame()
    ready = true
    advanceFrame()
    await Promise.resolve()
    expect(settled).toBe(false)
    advanceFrame()
    await pending
    expect(frames.size).toBe(0)
  })

  it('rejects timeout and removes both pending frames and an unconsumed click listener', async () => {
    const button = new EventTarget()
    const pending = measureNativeSessionOpen(button, () => false)
    const rejected = expect(pending).rejects.toThrow('Native session readiness timed out')
    vi.advanceTimersByTime(15000)
    await rejected
    button.dispatchEvent(new Event('click'))
    expect(frames.size).toBe(0)

    const afterClick = measureNativeSessionOpen(button, () => false)
    const afterClickRejected = expect(afterClick).rejects.toThrow('Native session readiness timed out')
    button.dispatchEvent(new Event('click'))
    expect(frames.size).toBe(1)
    vi.advanceTimersByTime(15000)
    await afterClickRejected
    expect(frames.size).toBe(0)
  })

  it('surfaces a broken readiness check without leaving a polling loop behind', async () => {
    const button = new EventTarget()
    const error = new Error('fixture DOM contract failed')
    const pending = measureNativeSessionOpen(button, () => { throw error })
    const rejected = expect(pending).rejects.toBe(error)
    button.dispatchEvent(new Event('click'))
    advanceFrame()
    await rejected
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
