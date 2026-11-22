import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

const savedMode = process.env.SCRY_ORCHESTRATION
afterEach(() => {
  if (savedMode === undefined) delete process.env.SCRY_ORCHESTRATION
  else process.env.SCRY_ORCHESTRATION = savedMode
  cleanupTempDirs()
})

describe('branch trial defaults', () => {
  it('unset SCRY_ORCHESTRATION runs the daemon in on mode (subscribe advertised)', async () => {
    delete process.env.SCRY_ORCHESTRATION
    const daemon = await startTestDaemon()
    try {
      const info = await daemon.request({ op: 'daemonInfo' })
      expect(info.subscribe).toBe(1)
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('explicit SCRY_ORCHESTRATION=off keeps the legacy path', async () => {
    process.env.SCRY_ORCHESTRATION = 'off'
    const daemon = await startTestDaemon()
    try {
      const info = await daemon.request({ op: 'daemonInfo' })
      expect(info.subscribe).toBeUndefined()
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
