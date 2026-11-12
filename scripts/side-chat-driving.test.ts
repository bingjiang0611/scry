import { beforeEach, expect, it, vi } from 'vitest'

const driver = vi.hoisted(() => ({ click: vi.fn(), wait: vi.fn(), idle: vi.fn() }))
vi.mock('./app-driving.mjs', () => ({ createAppDriver: () => driver }))
import { sideChatDriver } from './side-chat-driving.mjs'

const ready = `.chat-transcript[aria-busy="false"][data-history-source="authoritative"]`
beforeEach(() => vi.resetAllMocks())

it('does not toggle a visible panel because a header reports it unpressed', async () => {
  const { showPanel } = sideChatDriver({
    evaluate: async (expression: string) => expression.includes('getAttribute')
  })
  await showPanel()
  expect(driver.click).not.toHaveBeenCalled()
})

it('reveals the hidden app panel and waits for its visible state', async () => {
  const { showPanel } = sideChatDriver({
    evaluate: async (expression: string) => expression.includes('.app.right-panel-hidden')
  })
  await showPanel()
  expect(driver.click).toHaveBeenCalledWith('.panel-pill:not(.summary-pill)')
  expect(driver.wait).toHaveBeenLastCalledWith(expect.stringContaining('checkVisibility'))
  expect(driver.wait).toHaveBeenLastCalledWith(expect.stringContaining('.app.has-right-panel:not(.right-panel-hidden)'))
})

it('does not finish opening a child while its transcript is still loading', async () => {
  let release!: () => void
  const loaded = new Promise<void>(resolve => { release = resolve })
  driver.wait.mockImplementation(async (condition: string) => {
    if (condition.includes(ready)) await loaded
  })
  const { openChildById } = sideChatDriver({ evaluate: async () => true })
  let finished = false
  const opening = openChildById('child').then(() => { finished = true })
  await vi.waitFor(() => expect(driver.wait).toHaveBeenCalledWith(expect.stringContaining(ready), 30000))
  expect(finished).toBe(false)
  expect(driver.idle).not.toHaveBeenCalled()
  release()
  await opening
  expect(finished).toBe(true)
})

it('fails rather than accepting a child whose transcript never becomes ready', async () => {
  driver.wait.mockImplementation(async (condition: string) => {
    if (condition.includes(ready)) throw new Error('transcript load timed out')
  })
  const { openChildById } = sideChatDriver({ evaluate: async () => true })
  await expect(openChildById('child')).rejects.toThrow('transcript load timed out')
  expect(driver.idle).not.toHaveBeenCalled()
})
