import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

// The former switch cannot turn off the authoritative event log.
afterEach(() => {
  vi.unstubAllEnvs()
  cleanupTempDirs()
})

describe('authoritative daemon defaults', () => {
  it('advertises subscriptions by default when the former switch is unset', async () => {
    vi.stubEnv('SCRY_ORCHESTRATION', undefined)
    const daemon = await startTestDaemon()
    try {
      const info = await daemon.request({ op: 'daemonInfo' })
      expect(info.subscribe).toBe(1)
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('a stale off value does not turn off subscriptions', async () => {
    vi.stubEnv('SCRY_ORCHESTRATION', 'off')
    const daemon = await startTestDaemon()
    try {
      const info = await daemon.request({ op: 'daemonInfo' })
      expect(info.subscribe).toBe(1)
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
