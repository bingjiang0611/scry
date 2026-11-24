import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { readSubscribedRuns } from './subscribe-active-runs'
import type { OrchestrationCommand } from './orchestrator-commands'

const PEER_A = `peer:${'a'.repeat(64)}`

function submit(commandId: string, runId: string, claimMode: 'immediate' | 'queued'): OrchestrationCommand {
  const payload = {
    runId, sessionKey: 'sess-q', provider: 'claude' as const, profile: 'default',
    cwd: '/tmp/ws', promptPreview: 'queued', claimMode, leaseOwner: 'daemon-1'
  }
  return {
    type: 'run.submit', commandId, actor: PEER_A, scope: 'local', at: 1_700_000_000_000,
    payload, payloadSha256: sha256Hex(canonicalJson(payload))
  }
}

// D1: the queue is host state, so a client that only sees the "live" run list would never learn a
// turn is waiting. A queued run is live, not a finished run with a slot.
describe('D1: subscribed runs include the host queue', () => {
  it('keeps a queued run in the live list with its position', () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-subq-'))
    const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
    try {
      sink.execute(submit('c1', 'run-live', 'immediate'))
      sink.execute(submit('c2', 'run-queued', 'queued'))
      const rows = readSubscribedRuns(sink, 1_700_000_000_500)
      const queued = rows.find((row) => row.runId === 'run-queued')
      expect(queued?.lifecycle).toBe('queued')
      expect(queued?.queuePosition).toBe(1)
    } finally {
      sink.close()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
