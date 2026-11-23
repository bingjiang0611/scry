import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { SubscribeEngine } from './subscribe-engine'
import { SubscribeHub } from './subscribe-hub'
import { noteProgressMarkerForSubscribeHub } from '../../daemon/orchestration-authority-subscribe'

// Managed-worktree preparation progress travels from the run binding's run_progress
// marker to the subscription: on the run row and run hint for devices (v3 has no watch
// op), and as the App window's own `workspaceSelection:progress` notice.

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const progress = {
  operationId: '11111111-1111-4111-8111-111111111111', repositoryId: 'a'.repeat(64), stage: 'checking_out',
  workspacePrepared: true, checkout: { completed: 32, total: 64, percent: 50 }, cancellable: true,
  details: ['工作区元数据已创建'], branch: 'scry/remote-1', baseRef: 'main', updatedAt: 1234
}
const marker = (value: Record<string, unknown>) => JSON.stringify(value)

function fixture(scope: 'local' | 'remote') {
  const dir = mkdtempSync(join(tmpdir(), 'scry-sub-progress-'))
  dirs.push(dir)
  const sink = EventSink.open({ userDataDir: dir, fullfsync: false, maxActiveRuns: 64 })
  const hub = new SubscribeHub()
  sink.setCommitObserver((seq) => hub.notifyCommit(seq))
  const engine = new SubscribeEngine({
    sink, hub, hostId: 'host-progress', authorizePeer: () => undefined, grantScope: () => scope,
    remoteCwdAuthorizer: () => (cwd) => cwd === '/tmp/ws1'
  })
  const payload = {
    runId: 'run-1', sessionKey: 'sess-1', provider: 'codex', profile: null, cwd: '/tmp/ws1', origin: 'local' as const,
    promptPreview: 'worktree', claimMode: 'immediate' as const, dispatchImmediately: true
  }
  sink.execute({
    type: 'run.submit', commandId: 'c-1', actor: 'system', scope: 'local', at: Date.now(),
    payload, payloadSha256: sha256Hex(canonicalJson(payload))
  })
  return { hub, engine, close: () => { hub.close(); sink.close() } }
}

describe('subscribe workspace preparation progress', () => {
  it('projects the latest step onto the device run row and completes it on admission', async () => {
    const { hub, engine, close } = fixture('remote')
    const device = 'b'.repeat(64)
    try {
      noteProgressMarkerForSubscribeHub(hub, 'run-1', marker({ event: 'bound', scryRunId: 'scry-1', cwd: '/tmp/ws1' }))
      noteProgressMarkerForSubscribeHub(hub, 'run-1', marker({ event: 'workspaceProgress', progress }))
      const first = await engine.subscribe(device, { views: ['sessions', 'activeRuns'], waitMs: 0 })
      if (first.mode !== 'snapshot') throw new Error('expected snapshot')
      expect(first.snapshot.activeRuns?.rows[0]).toMatchObject({ runId: 'run-1', traceRunId: 'scry-1', workspaceProgress: progress })

      noteProgressMarkerForSubscribeHub(hub, 'run-1', marker({ event: 'admitted', scryRunId: 'scry-1' }))
      const next = await engine.subscribe(device, {
        views: ['sessions', 'activeRuns'], known: { hostId: first.hostId, logId: first.logId, seq: first.seq }, waitMs: 0
      })
      expect(next.hints?.find((item) => item.kind === 'run'))
        .toMatchObject({ kind: 'run', runId: 'run-1', workspaceProgress: { stage: 'completed', cancellable: false } })
      expect(next.hints?.some((item) => item.kind === 'window')).toBe(false)
    } finally { close() }
  })

  it('gives the App one current progress notice per run and drops malformed markers', async () => {
    const { hub, engine, close } = fixture('local')
    const app = 'a'.repeat(64)
    try {
      const first = await engine.subscribe(app, { views: ['activeRuns'], waitMs: 0 })
      noteProgressMarkerForSubscribeHub(hub, 'run-1', marker({ event: 'workspaceProgress', progress: { ...progress, stage: 'preparing' } }))
      noteProgressMarkerForSubscribeHub(hub, 'run-1', marker({ event: 'workspaceProgress', progress }))
      noteProgressMarkerForSubscribeHub(hub, 'run-1', marker({ event: 'workspaceProgress', progress: { ...progress, stage: 'unknown' } }))
      const next = await engine.subscribe(app, {
        views: ['activeRuns'], known: { hostId: first.hostId, logId: first.logId, seq: first.seq }, waitMs: 0
      })
      expect(next.hints?.filter((item) => item.kind === 'window'))
        .toEqual([{ kind: 'window', channel: 'workspaceSelection:progress', payload: progress }])
      const reopened = await engine.subscribe('c'.repeat(64), { views: ['activeRuns'], waitMs: 0 })
      if (reopened.mode !== 'snapshot') throw new Error('expected snapshot')
      expect(reopened.snapshot.activeRuns?.rows[0]?.workspaceProgress).toEqual(progress)
    } finally { close() }
  })
})
