import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)


describe('daemon MCP channels', () => {
  it('answers snapshot, guard scan, test and re-auth from the daemon', async () => {
    const daemon = await startTestDaemon()
    try {
      const context = { providerId: 'codex', cwd: daemon.workspace }
      const scan = await daemon.localOp('mcp', 'mcpGuardScan', [context])
      expect(scan.error).toBeUndefined()
      expect(scan.result).toMatchObject({ providerId: 'codex', mode: 'read' })
      expect(['ready', 'degraded']).toContain((scan.result as { state: string }).state)
      const snapshot = await daemon.localOp('mcp', 'mcpSnapshot', [{ context, refresh: false }])
      expect(snapshot.error).toBeUndefined()
      expect(snapshot.result).toMatchObject({ providerId: 'codex' })
      for (const method of ['testMcp', 'reauthenticateMcp']) {
        const answer = await daemon.localOp('mcp', method, [{ context, targetId: 'missing' }])
        expect(answer.error, method).not.toBe('unsupported_op')
        expect(answer.error === undefined ? answer.result : answer.error, method).toBeTruthy()
      }
      const pi = await daemon.localOp('mcp', 'mcpGuardScan', [{ providerId: 'pi', cwd: daemon.workspace }])
      expect(pi.result).toMatchObject({ state: 'unsupported' })
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
