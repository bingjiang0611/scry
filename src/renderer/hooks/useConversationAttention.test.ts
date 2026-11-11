import { afterEach, expect, it, vi } from 'vitest'
const effects = vi.hoisted(() => ({ current: undefined as (() => void | (() => void)) | undefined }))
vi.mock('react', () => ({ useEffect: (effect: () => void | (() => void)) => { effects.current = effect } }))
import { useConversationAttention } from './useConversationAttention'

afterEach(() => { vi.unstubAllGlobals(); effects.current = undefined })

it('reports open and visibility changes, avoids duplicate focus IPC, and releases listeners on leave', async () => {
  let hidden = false
  const document = new EventTarget()
  Object.defineProperty(document, 'hidden', { get: () => hidden })
  const setViewed = vi.fn(async (_id: string | null) => {})
  const window = Object.assign(new EventTarget(), { scry: { conversations: { setViewed } } })
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  useConversationAttention('first')
  const cleanup = effects.current!()
  hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  cleanup?.()
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  await Promise.resolve()
  expect(setViewed.mock.calls).toEqual([['first'], [null], ['first'], [null]])
})

it('releases a previous renderer view on initial mount outside a visible conversation', () => {
  const setViewed = vi.fn(async (_id: string | null) => {})
  vi.stubGlobal('window', { scry: { conversations: { setViewed } } })
  useConversationAttention(undefined)
  expect(effects.current!()).toBeUndefined()
  expect(setViewed.mock.calls).toEqual([[null]])
})

it('does nothing, instead of throwing, when the bridge has no conversation attention', () => {
  // The shell mounts this hook on every view. A renderer without the method must keep
  // rendering; before this guard the desktop-remote UI smoke blanked on a TypeError.
  for (const scry of [undefined, {}, { conversations: {} }]) {
    vi.stubGlobal('window', { scry })
    useConversationAttention(undefined)
    expect(() => effects.current!()).not.toThrow()
  }
})
