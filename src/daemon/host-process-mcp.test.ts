import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

// B4-L4 MCP: the daemon answers the four MCP channels with main's handlers. The smoke
// Provider has no MCP servers, so the answers are its explicit envelopes; what matters
// here is that they come from the daemon, in main's shape, and never as unsupported_op.

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
        // Main's own answer for a target this Provider does not have: an error or an
        // envelope, never the op being absent.
        expect(answer.error, method).not.toBe('unsupported_op')
        expect(answer.error === undefined ? answer.result : answer.error, method).toBeTruthy()
      }
      // A Pi guard scan stays the explicit unsupported envelope, not an empty report.
      const pi = await daemon.localOp('mcp', 'mcpGuardScan', [{ providerId: 'pi', cwd: daemon.workspace }])
      expect(pi.result).toMatchObject({ state: 'unsupported' })
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
