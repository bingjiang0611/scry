import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusComposerUnlessFocusMoved } from './composer-focus'

// 这条不变式曾经在真实 App 上失败：新建会话的 setTimeout(0) 焦点请求晚于侧边栏 Surface
// 菜单的 Escape 恢复执行，把焦点从“+”按钮抢回 composer。jsdom 不参与，所以用最小
// document/window 替身锁住“意图开始之后出现的焦点优先”。
type Fakes = {
  textarea: { focus: ReturnType<typeof vi.fn> }
  sbNew: unknown
  plus: unknown
  body: unknown
  setFocus: (node: unknown) => void
}

const fakeDom = (): void => {
  const state: { active: unknown } = { active: null }
  const focus = vi.fn(function (this: unknown) { state.active = this })
  const textarea = { tag: 'textarea', focus }
  // “新建会话”点击后焦点在它自己身上；菜单的 Escape 之后焦点属于“+”按钮。
  const sbNew = { tag: 'button', name: 'sb-new' }
  const plus = { tag: 'button', name: 'surface-add' }
  const body = { tag: 'body' }
  Object.assign(globalThis, {
    document: { get activeElement() { return state.active }, body },
    window: { setTimeout: (handler: () => void) => setTimeout(handler, 0) }
  })
  state.active = sbNew
  Object.assign(globalThis, { __fakes: { textarea, sbNew, plus, body, setFocus: (node: unknown): void => { state.active = node } } })
}

const fakes = (): Fakes => (globalThis as unknown as { __fakes: Fakes }).__fakes
const composer = (): { current: HTMLTextAreaElement | null } => ({ current: fakes().textarea as unknown as HTMLTextAreaElement })

describe('延迟的 composer 焦点', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(globalThis, 'document')
    Reflect.deleteProperty(globalThis, 'window')
    Reflect.deleteProperty(globalThis, '__fakes')
  })

  it('没有更新的焦点时把光标放进 composer', () => {
    fakeDom()
    // 点击时的焦点就是意图基线，之后没人动它。
    focusComposerUnlessFocusMoved(composer(), fakes().sbNew as Element)
    vi.runAllTimers()
    expect(fakes().textarea.focus).toHaveBeenCalledTimes(1)
  })

  it('意图开始后别的元素拿到焦点时让位给更新的意图', () => {
    fakeDom()
    const before = fakes().sbNew as Element
    // 新会话的 newSession 还没回来，Surface 菜单的 Escape 已经把焦点还给“+”按钮。
    fakes().setFocus(fakes().plus)
    focusComposerUnlessFocusMoved(composer(), before)
    vi.runAllTimers()
    expect(fakes().textarea.focus).not.toHaveBeenCalled()
  })

  it('焦点落回 body（浮层卸载）时仍聚焦 composer', () => {
    fakeDom()
    focusComposerUnlessFocusMoved(composer(), fakes().sbNew as Element)
    fakes().setFocus(fakes().body)
    vi.runAllTimers()
    expect(fakes().textarea.focus).toHaveBeenCalledTimes(1)
  })

  it('composer 已卸载时什么也不做', () => {
    fakeDom()
    focusComposerUnlessFocusMoved({ current: null }, fakes().sbNew as Element)
    vi.runAllTimers()
    expect(fakes().textarea.focus).not.toHaveBeenCalled()
  })
})
