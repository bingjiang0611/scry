import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

const { openChildById, showPanel, wait } = vi.hoisted(() => ({ openChildById: vi.fn(), showPanel: vi.fn(), wait: vi.fn() }))
vi.mock('./side-chat-driving.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('./side-chat-driving.mjs')>(),
  sideChatDriver: () => ({ openChildById, showPanel, wait })
}))
vi.mock('./side-chat-window-control.mjs', () => ({
  createWindowResize: () => ({ resize: async () => undefined })
}))
import { exerciseSideChatLayout } from './side-chat-layout-checks.mjs'
import { SIDE_CHAT_SURFACE } from './side-chat-driving.mjs'

it('restores the tested child after keyboard tab activation before composition and injection checks', () => {
  const layout = readFileSync(new URL('./side-chat-layout-checks.mjs', import.meta.url), 'utf8')
  const input = readFileSync(new URL('./side-chat-input-checks.mjs', import.meta.url), 'utf8')
  const composition = input.slice(input.indexOf('// 6. Real IME'), input.indexOf('const beforeComposition'))
  expect(composition).toMatch(/await showChild\(\)[\s\S]*?await click\(CHILD_COMPOSER\)/)
  expect(layout).toMatch(/check\(tabKeys.every[\s\S]*?await exerciseSideChatInput\(/)
  expect(input).toContain(".chat-body .chat-transcript")
  expect(input).toContain('document.elementFromPoint(point.x, point.y) !== scroller')
  expect(input).not.toContain("driver.pointerAt(`document.querySelector('${CHILD_PANEL} .chat-body')`)")
})

it('awaits the restored child, visible panel and loaded transcript before measuring', async () => {
  let restore!: () => void
  let reveal!: () => void
  let release!: () => void
  const restored = new Promise<void>(resolve => { restore = resolve })
  const visible = new Promise<void>(resolve => { reveal = resolve })
  const ready = new Promise<void>(resolve => { release = resolve })
  wait.mockImplementation(() => restored)
  showPanel.mockImplementation(() => visible)
  openChildById.mockImplementation(() => ready)
  const measured = vi.fn()
  const evaluate = async (expression: string) => {
    if (expression.includes('dataset.sideChatId ?? null')) return 'child'
    if (expression.includes('const surface =')) {
      measured()
      throw new Error('layout measurement reached')
    }
    return false // Panel is shown and its current session surface exists.
  }
  const run = exerciseSideChatLayout({ evaluate, childId: 'child' }).catch((error: Error) => error)
  try {
    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(
      `document.querySelector('${SIDE_CHAT_SURFACE} [data-side-chat-tab-id="child"]') != null`, 30000))
    expect(showPanel).not.toHaveBeenCalled()
    restore()
    await vi.waitFor(() => expect(showPanel).toHaveBeenCalledOnce())
    expect(openChildById).not.toHaveBeenCalled()
    reveal()
    await vi.waitFor(() => expect(openChildById).toHaveBeenCalledWith('child'))
    expect(measured).not.toHaveBeenCalled()
  } finally {
    restore()
    reveal()
    release()
  }
  expect((await run).message).toBe('layout measurement reached')
  expect(measured).toHaveBeenCalledOnce()
})
