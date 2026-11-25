import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it, onTestFailed, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { withProbeFixture } from './pi-rpc.fixture'
import { createPiAdapter } from './pi'

/**
 * C3: the model's answer ends the run even while a detached child is still working. The session is
 * not idle-and-ignored: the kept process reports the child's result and the host is told to wake the
 * session with an agent-origin run.
 */
describe('Pi answer settles while a child runs', () => {
  it('resolves at the answer and reports the child completion for a wake', async () => {
    await withProbeFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const events: TraceEvent[] = []
      const wakes: Array<{ taskIds: string[]; reason: string }> = []
      const startedAt = Date.now()
      onTestFailed(() => {
        console.error('Pi background settle evidence', JSON.stringify({
          elapsedMs: Date.now() - startedAt, wakes,
          stages: events.map((event) => `${event.stage}@${Date.parse(event.ts) - startedAt}`).slice(-20)
        }))
      })
      let checkpoint!: () => void
      const waiting = new Promise<void>((resolve) => { checkpoint = resolve })
      const handle = adapter.run({
        runId: 'background-settle', prompt: 'background-child', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access',
        emit(event) {
          events.push(event)
          if (event.text?.includes('child waiting checkpoint')) checkpoint()
        },
        onBackgroundWake(input) { wakes.push({ taskIds: input.taskIds, reason: input.reason }) }
      })
      await Promise.race([waiting, handle.promise.then(() => { throw new Error('run ended before the child checkpoint') })])

      // The answer is complete: this run ends now, without waiting for the child.
      await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
      expect(wakes).toEqual([])

      const release = spawnSync('/bin/sh', ['-c', 'printf "%s\\n" "$1" > "$2"', 'release-child', 'continue', join(cwd, 'release-child')], { timeout: 2_000 })
      expect(release.status).toBe(0)

      // The kept process reports the child's terminal state, which is the wake the host needs.
      await vi.waitFor(() => expect(wakes).toEqual([{ taskIds: ['child-1'], reason: 'terminal' }]), { timeout: 5_000 })
    })
  }, 30_000)
})
