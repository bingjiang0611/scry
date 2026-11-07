import { describe, expect, it, vi } from 'vitest'
import { createDaemonSignalShutdown } from './signal-shutdown'

describe('daemon signal shutdown', () => {
  it('honors SIGTERM received before host startup finishes', async () => {
    const exit = vi.fn()
    const dispose = vi.fn(async () => undefined)
    const shutdown = createDaemonSignalShutdown(exit)
    shutdown.stop()
    expect(dispose).not.toHaveBeenCalled()
    shutdown.ready(dispose)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(dispose).toHaveBeenCalledOnce()
  })
})
