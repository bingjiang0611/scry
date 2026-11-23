import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusComposerWhenReady } from './composer-focus'

// A freshly created side chat mounts before its page arrives; its composer only renders
// with the page. With the daemon as the only runtime that read lands later, so the focus
// must wait for the composer instead of trying once. Minimal document/window fakes, as in
// composer-focus.test.ts: jsdom is not part of this suite.

function fakeDom() {
  const state: { active: unknown } = { active: null }
  const body = { tag: 'body' }
  const card = { tag: 'button', name: 'side-chat-entry' }
  const textarea = { tag: 'textarea', disabled: false, focus: vi.fn(function (this: unknown) { state.active = this }) }
  Object.assign(globalThis, {
    document: { get activeElement() { return state.active }, body },
    window: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) }
  })
  state.active = card
  return { state, body, card, textarea }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'window')
})

describe('composer focus once the composer exists', () => {
  it('focuses the composer when it renders after mount', () => {
    const dom = fakeDom()
    const target: { current: HTMLTextAreaElement | null } = { current: null }
    focusComposerWhenReady(target, dom.card as unknown as Element)
    dom.state.active = dom.body // the chooser card unmounted
    vi.advanceTimersByTime(100)
    expect(dom.textarea.focus).not.toHaveBeenCalled()
    target.current = dom.textarea as unknown as HTMLTextAreaElement
    vi.advanceTimersByTime(20)
    expect(dom.textarea.focus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up once anything else takes focus, and when cancelled', () => {
    const dom = fakeDom()
    const target: { current: HTMLTextAreaElement | null } = { current: null }
    focusComposerWhenReady(target, dom.card as unknown as Element)
    dom.state.active = { tag: 'textarea', name: 'main composer' }
    target.current = dom.textarea as unknown as HTMLTextAreaElement
    vi.advanceTimersByTime(200)
    expect(dom.textarea.focus).not.toHaveBeenCalled()

    const again = fakeDom()
    const ready = { current: null as HTMLTextAreaElement | null }
    const cancel = focusComposerWhenReady(ready, again.card as unknown as Element)
    cancel()
    ready.current = again.textarea as unknown as HTMLTextAreaElement
    vi.advanceTimersByTime(200)
    expect(again.textarea.focus).not.toHaveBeenCalled()
  })

  it('stops waiting after its bound', () => {
    const dom = fakeDom()
    focusComposerWhenReady({ current: null }, dom.card as unknown as Element, 100)
    vi.advanceTimersByTime(500)
    expect(vi.getTimerCount()).toBe(0)
    expect(dom.textarea.focus).not.toHaveBeenCalled()
  })
})
