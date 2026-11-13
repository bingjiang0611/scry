import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPresenceExits, usePresence } from './usePresence'

// Node has no DOM renderer. Exercise the real hook callbacks/cleanup with a tiny
// hook harness; native Electron tests separately prove React, CSS and input wiring.
const harness = vi.hoisted(() => ({ cleanups: [] as Array<() => void>, state: 'enter', flushes: 0 }))
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (initial: string) => [initial, (next: string) => { harness.state = next }],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void)) => { harness.cleanups.push(effect()) },
  useLayoutEffect: (effect: () => (() => void)) => { harness.cleanups.push(effect()) }
}))
vi.mock('react-dom', () => ({ flushSync: (callback: () => void) => { harness.flushes++; callback() } }))

type StubAnimation = { playState: string; effect: { getComputedTiming: () => { endTime: number } } }
class PresenceNode extends EventTarget {
  dataset = { state: 'enter' }
  inert = false
  animations: StubAnimation[] = []
  getAnimations() { return this.animations }
}
let documentEvents: EventTarget
let media: { matches: boolean }
function mount(onClose = vi.fn(), exitMs = 160, onExitStart = vi.fn()) {
  const presence = usePresence({ onClose, exitMs, onExitStart })
  const node = new PresenceNode()
  presence.ref(node as unknown as HTMLElement)
  const unmount = harness.cleanups.at(-1)!
  return { ...presence, node, onClose, onExitStart, unmount }
}
beforeEach(() => {
  vi.useFakeTimers()
  harness.cleanups = []; harness.state = 'enter'; harness.flushes = 0
  documentEvents = new EventTarget()
  media = { matches: false }
  vi.stubGlobal('document', documentEvents)
  vi.stubGlobal('window', { matchMedia: () => media })
})
afterEach(() => {
  harness.cleanups.forEach(cleanup => cleanup())
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('overlay presence lifecycle', () => {
  it('retires input at exit start and closes once on its own animationend', () => {
    const p = mount()
    p.requestClose('button')
    expect(harness.state).toBe('exit')
    expect(p.node.dataset.state).toBe('exit')
    expect(p.node.inert).toBe(true)
    expect(p.onExitStart).toHaveBeenCalledOnce()
    expect(p.onClose).not.toHaveBeenCalled()
    p.node.dispatchEvent(new Event('animationend'))
    expect(p.onClose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores repeated close requests and descendant animationend', () => {
    const p = mount()
    const add = vi.spyOn(p.node, 'addEventListener')
    p.requestClose('escape'); p.requestClose('button')
    const listener = add.mock.calls.find(([type]) => type === 'animationend')![1] as EventListener
    const descendantEnd = new Event('animationend')
    Object.defineProperty(descendantEnd, 'target', { value: new PresenceNode() })
    listener(descendantEnd)
    expect(p.onClose).not.toHaveBeenCalled()
    p.node.dispatchEvent(new Event('animationend'))
    vi.runAllTimers()
    p.requestClose('backdrop')
    expect(p.onClose).toHaveBeenCalledOnce()
    expect(p.onClose).toHaveBeenCalledWith('escape')
    expect(p.onExitStart).toHaveBeenCalledOnce()
  })
  it('waits for every finite exit animation before closing', () => {
    const p = mount()
    const longer: StubAnimation = { playState: 'running', effect: { getComputedTiming: () => ({ endTime: 320 }) } }
    p.node.animations = [longer]
    p.requestClose('button')
    // CI removed one node 53ms after its animation start because a shorter animation ended first.
    p.node.dispatchEvent(new Event('animationend'))
    expect(p.onClose).not.toHaveBeenCalled()
    longer.playState = 'finished'
    p.node.dispatchEvent(new Event('animationend'))
    expect(p.onClose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores an endless ambient animation when the exit finishes', () => {
    const p = mount()
    p.node.animations = [{ playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) } }]
    p.requestClose('button')
    p.node.dispatchEvent(new Event('animationend'))
    expect(p.onClose).toHaveBeenCalledOnce()
  })
  it('uses exitMs + 40 when animationend is missing', () => {
    const p = mount()
    p.requestClose('backdrop')
    vi.advanceTimersByTime(199)
    expect(p.onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(p.onClose).toHaveBeenCalledOnce()
    p.node.dispatchEvent(new Event('animationend'))
    expect(p.onClose).toHaveBeenCalledOnce()
  })
  it('re-anchors the fallback at the real animation start instead of deleting mid-animation', () => {
    const p = mount(vi.fn(), 160)
    p.requestClose('button')
    // A stalled main thread delivers animationstart long after the state change.
    vi.advanceTimersByTime(80)
    p.node.dispatchEvent(new Event('animationstart'))
    vi.advanceTimersByTime(199)
    expect(p.onClose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    // animationend still finishes first once the compositor completes the exit.
    p.node.dispatchEvent(new Event('animationend'))
    expect(p.onClose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('never postpones removal past the ceiling measured from the close request', () => {
    const p = mount(vi.fn(), 160)
    p.requestClose('button')
    // A renderer that keeps reporting animation starts cannot push removal past the ceiling:
    // closeStart + (exitMs + 40) + 200 = 400ms here.
    for (let step = 0; step < 3; step++) {
      vi.advanceTimersByTime(100)
      p.node.dispatchEvent(new Event('animationstart'))
    }
    vi.advanceTimersByTime(99)
    expect(p.onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(p.onClose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps the fallback bounded when the re-anchored animation end is dropped', () => {
    const p = mount(vi.fn(), 160)
    p.requestClose('button')
    vi.advanceTimersByTime(60)
    p.node.dispatchEvent(new Event('animationstart'))
    vi.advanceTimersByTime(199)
    expect(p.onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(p.onClose).toHaveBeenCalledOnce()
  })
  it('ignores a descendant animation start and a repeated parent start', () => {
    const p = mount(vi.fn(), 160)
    p.requestClose('button')
    const descendantStart = new Event('animationstart')
    Object.defineProperty(descendantStart, 'target', { value: new PresenceNode() })
    p.node.dispatchEvent(descendantStart)
    vi.advanceTimersByTime(150)
    expect(p.onClose).not.toHaveBeenCalled()
    p.node.dispatchEvent(new Event('animationstart'))
    vi.advanceTimersByTime(199)
    expect(p.onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(p.onClose).toHaveBeenCalledOnce()
  })
  it('uses 150ms + 40 under reduced motion', () => {
    media.matches = true
    const p = mount()
    p.requestClose('escape')
    vi.advanceTimersByTime(189)
    expect(p.onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(p.onClose).toHaveBeenCalledOnce()
  })
  it('removes timer, animation listener and document capture listeners on unmount', () => {
    const p = mount()
    const removeNode = vi.spyOn(p.node, 'removeEventListener')
    const removeDocument = vi.spyOn(documentEvents, 'removeEventListener')
    p.requestClose('button'); p.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(removeNode).toHaveBeenCalledWith('animationend', expect.any(Function))
    expect(removeNode).toHaveBeenCalledWith('animationstart', expect.any(Function))
    expect(removeDocument).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    expect(removeDocument).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    p.node.dispatchEvent(new Event('animationend'))
    flushPresenceExits(); vi.runAllTimers()
    expect(p.onClose).not.toHaveBeenCalled()
  })
  it('flushes the pending parent close synchronously before the next interaction', () => {
    const p = mount()
    p.requestClose('button')
    documentEvents.dispatchEvent(new Event('pointerdown'))
    expect(harness.flushes).toBe(1)
    expect(p.onClose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not call an unmounted child when closing its parent flushes both exits', () => {
    let unmountChild = (): void => {}
    const parent = mount(vi.fn(() => unmountChild()))
    const child = mount()
    unmountChild = child.unmount
    parent.requestClose('button'); child.requestClose('escape')
    flushPresenceExits()
    expect(parent.onClose).toHaveBeenCalledOnce()
    expect(child.onClose).not.toHaveBeenCalled()
  })
  it('can reset an interrupted menu exit and close the new cycle once', () => {
    const p = mount(vi.fn(), 100)
    p.requestClose('pointer'); p.reset()
    expect(harness.state).toBe('enter')
    expect(p.node.inert).toBe(false)
    vi.runAllTimers()
    expect(p.onClose).not.toHaveBeenCalled()
    p.requestClose('button')
    p.node.dispatchEvent(new Event('animationend'))
    expect(p.onClose).toHaveBeenCalledOnce()
  })
})
