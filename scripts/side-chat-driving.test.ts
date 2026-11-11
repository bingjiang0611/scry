import { beforeEach, expect, it, vi } from 'vitest'

const driver = vi.hoisted(() => ({ click: vi.fn(), wait: vi.fn(), idle: vi.fn() }))
vi.mock('./app-driving.mjs', () => ({ createAppDriver: () => driver }))
import { CHILD_PANEL, sideChatDriver } from './side-chat-driving.mjs'

const ready = `document.querySelector('${CHILD_PANEL} .chat-transcript[aria-busy="false"][data-history-source="authoritative"]') != null`
beforeEach(() => vi.resetAllMocks())

it('does not finish opening a child while its transcript is still loading', async () => {
  let release!: () => void
  const loaded = new Promise<void>(resolve => { release = resolve })
  driver.wait.mockImplementation(async (condition: string) => {
    if (condition === ready) await loaded
  })
  const { openChildById } = sideChatDriver({ evaluate: async () => true })
  let finished = false
  const opening = openChildById('child').then(() => { finished = true })
  await vi.waitFor(() => expect(driver.wait).toHaveBeenCalledWith(ready, 30000))
  expect(finished).toBe(false)
  expect(driver.idle).not.toHaveBeenCalled()
  release()
  await opening
  expect(finished).toBe(true)
})

it('fails rather than accepting a child whose transcript never becomes ready', async () => {
  driver.wait.mockImplementation(async (condition: string) => {
    if (condition === ready) throw new Error('transcript load timed out')
  })
  const { openChildById } = sideChatDriver({ evaluate: async () => true })
  await expect(openChildById('child')).rejects.toThrow('transcript load timed out')
  expect(driver.idle).not.toHaveBeenCalled()
})
