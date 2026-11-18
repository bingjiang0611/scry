import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

// The harness the local-op group tests share: it must reach a real daemon's App channels.
describe('test daemon harness', () => {
  it('answers a local op from temporary userData and cleans up', async () => {
    const daemon = await startTestDaemon()
    try {
      const recent = await daemon.localOp('projectStore', 'recentFolders', [])
      expect(recent.result).toContain(daemon.workspace)
      expect(daemon.userDataDir.startsWith(daemon.root)).toBe(true)
    } finally {
      await daemon.dispose()
    }
    expect(process.env.SCRY_ELECTRON_SMOKE_PROVIDER).not.toBe('1')
  }, 30_000)
})
