import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { pruneOrchestrationInDb } from './orchestration-retention'

// R13: a command the local user made through the App was recorded with actor `system`, so retention
// deleted its receipt after 30 days — the user's own action became indistinguishable from an internal
// system command that is allowed to expire.
it('keeps a local user command receipt past the system retention window', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-r13-actor-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const at = 1_700_000_000_000
    const submit = (actor: string) => {
      const payload = { runId: 'run-1', sessionKey: 'native-1', provider: 'pi', profile: null, cwd: '/tmp/p', promptPreview: 'p' }
      return sink.execute({
        type: 'run.submit',
        commandId: `submit:${actor}`,
        actor,
        scope: 'system',
        at,
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload))
      } as never)
    }
    expect(submit('user:local').kind).toBe('accepted')
    expect(sink.handle.db.prepare('SELECT actor FROM orch_command WHERE command_id = ?').get('submit:user:local'))
      .toEqual({ actor: 'user:local' })

    const longAfter = at + 400 * 24 * 3_600_000
    pruneOrchestrationInDb(sink.handle.db, { now: longAfter })
    // The user's own action is still recorded; an internal system receipt of the same age is not.
    expect(sink.handle.db.prepare('SELECT 1 FROM orch_command WHERE command_id = ?').get('submit:user:local'))
      .toBeDefined()
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
