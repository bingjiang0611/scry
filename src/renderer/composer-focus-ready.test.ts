import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusComposerWhenReady } from './composer-focus'

// A freshly created side chat mounts before its page arrives; its composer only renders
// with the page. With the daemon as the only runtime that read lands frames later, so the
// focus must wait for the composer instead of trying once. Minimal document/window fakes,
// as in composer-focus.test.ts: jsdom is not part of this suite.

function fakeDom() {
  const state: { active: unknown } = { active: null }
  const frames: Array<() => void> = []
  const body = { tag: 'body' }
  const card = { tag: 'button', name: 'side-chat-entry' }
  const textarea = { tag: 'textarea', disabled: false, focus: vi.fn(function (this: unknown) { state.active = this }) }
  Object.assign(globalThis, {
    document: { get activeElement() { return state.active }, body },
    window: {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      cancelAnimationFrame: (id: number) => { frames[id - 1] = () => {} }
    }
  })
  state.active = card
  const runFrames = (count: number) => { for (let index = 0; index < count; index++) frames.shift()?.() }
  return { state, body, card, textarea, runFrames, pending: () => frames.length }
}

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'window')
})

describe('composer focus once the composer exists', () => {
  it('focuses the composer when it renders frames after mount', () => {
    const dom = fakeDom()
    const target: { current: HTMLTextAreaElement | null } = { current: null }
    focusComposerWhenReady(target, dom.card as unknown as Element)
    dom.state.active = dom.body // the chooser card unmounted
    dom.runFrames(3)
    expect(dom.textarea.focus).not.toHaveBeenCalled()
    target.current = dom.textarea as unknown as HTMLTextAreaElement
    dom.runFrames(1)
    expect(dom.textarea.focus).toHaveBeenCalledTimes(1)
    expect(dom.pending()).toBe(0)
  })

  it('gives up once anything else takes focus, and when cancelled', () => {
    const dom = fakeDom()
    const target: { current: HTMLTextAreaElement | null } = { current: null }
    focusComposerWhenReady(target, dom.card as unknown as Element)
    dom.state.active = { tag: 'textarea', name: 'main composer' }
    target.current = dom.textarea as unknown as HTMLTextAreaElement
    dom.runFrames(5)
    expect(dom.textarea.focus).not.toHaveBeenCalled()

    const again = fakeDom()
    const ready = { current: null as HTMLTextAreaElement | null }
    const cancel = focusComposerWhenReady(ready, again.card as unknown as Element)
    cancel()
    ready.current = again.textarea as unknown as HTMLTextAreaElement
    again.runFrames(5)
    expect(again.textarea.focus).not.toHaveBeenCalled()
  })

  it('stops waiting after its bound', () => {
    vi.useFakeTimers()
    const dom = fakeDom()
    focusComposerWhenReady({ current: null }, dom.card as unknown as Element, 100)
    dom.runFrames(2)
    vi.advanceTimersByTime(200)
    dom.runFrames(1)
    expect(dom.pending()).toBe(0)
  })
})
