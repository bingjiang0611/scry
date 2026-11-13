import { afterEach, expect, it, vi } from 'vitest'
import { wait } from './workspace-session-ui-run.mjs'

afterEach(() => vi.useRealTimers())

it.each([
  { label: 'original default', timeoutMs: undefined, deadline: 20000 },
  { label: 'remaining reload budget', timeoutMs: 50, deadline: 50 }
])('preserves the $label deadline', async ({ timeoutMs, deadline }) => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const pending = expect(wait(() => false, 'target', timeoutMs)).rejects.toThrow('Timed out: target')
  await vi.runAllTimersAsync()
  await pending
  expect(Date.now()).toBe(deadline)
})

it('propagates a failed probe without retrying it', async () => {
  const probe = vi.fn().mockRejectedValue(new Error('renderer crashed'))
  await expect(wait(probe, 'target', 50)).rejects.toThrow('renderer crashed')
  expect(probe).toHaveBeenCalledOnce()
})
