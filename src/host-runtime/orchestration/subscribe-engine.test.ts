import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { SubscribeEngine } from './subscribe-engine'
import { SubscribeHub } from './subscribe-hub'

const tempDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-sub-engine-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function submitRun(sink: EventSink, input: {
  commandId: string
  runId: string
  sessionKey: string
  cwd: string
  promptPreview?: string
  at?: number
  dispatchImmediately?: boolean
}) {
  const payload = {
    runId: input.runId,
    sessionKey: input.sessionKey,
    provider: 'codex',
    profile: null,
    cwd: input.cwd,
    origin: 'local' as const,
    promptPreview: input.promptPreview ?? 'hello world',
    claimMode: 'immediate' as const,
    ...(input.dispatchImmediately ? { dispatchImmediately: true } : {})
  }
  return sink.execute({
    type: 'run.submit',
    commandId: input.commandId,
    actor: 'system',
    scope: 'local',
    at: input.at ?? Date.now(),
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
}

function settleRun(sink: EventSink, runId: string, at = Date.now()) {
  const payload = { runId, step: 'settled' as const, settledAt: at, evidence: ['provider'] }
  return sink.execute({
    type: 'run.effect_result',
    commandId: `effect:${runId}:settled`,
    actor: `effect:${runId}`,
    scope: 'system',
    at,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
}

describe('SubscribeEngine + SubscribeHub (P4-3 protocol §5)', () => {
  it('returns snapshot without known cursor, then incremental events, and advances seq on idle', async () => {
    const dir = makeDir()
    const sink = EventSink.open({ userDataDir: dir, fullfsync: false, maxActiveRuns: 64 })
    const hub = new SubscribeHub({
      stateHints: () => [{ kind: 'attention', snapshot: { revision: 1, unreadSessionKeys: ['s1'] } }]
    })
    sink.setCommitObserver((seq) => hub.notifyCommit(seq))
    const engine = new SubscribeEngine({
      sink,
      hub,
      hostId: 'host-test-1',
      authorizePeer: () => undefined,
      grantScope: () => 'local'
    })
    try {
      const peer = 'a'.repeat(64)
      submitRun(sink, { commandId: 'c-1', runId: 'run-1', sessionKey: 'sess-1', cwd: '/tmp/ws1', dispatchImmediately: true })
      hub.noteRunBound('run-1', { scryRunId: 'scry-1', cwd: '/tmp/ws1', providerId: 'codex' })
      hub.noteRunAdmitted('run-1', 'scry-1')
      hub.noteRunOutput('run-1', 3)

      const first = await engine.subscribe(peer, { views: ['sessions', 'activeRuns'], waitMs: 0 })
      expect(first.mode).toBe('snapshot')
      if (first.mode !== 'snapshot') throw new Error('expected snapshot')
      expect(first.hostId).toBe('host-test-1')
      expect(first.logId).toBeTruthy()
      expect(first.seq).toBeGreaterThan(0)
      expect(first.snapshot.activeRuns?.rows).toHaveLength(1)
      expect(first.snapshot.activeRuns?.rows[0]).toMatchObject({
        runId: 'run-1',
        scryRunId: 'scry-1',
        admitted: true,
        outputSeq: 3,
        lifecycle: 'dispatched'
      })
      expect(first.snapshot.sessions?.rows).toHaveLength(1)
      expect(first.hints?.some((h) => h.kind === 'attention')).toBe(true)

      // Settle run-1 -> incremental events mode
      settleRun(sink, 'run-1')
      const second = await engine.subscribe(peer, {
        views: ['sessions', 'activeRuns'],
        known: { hostId: first.hostId, logId: first.logId, seq: first.seq },
        waitMs: 0
      })
      expect(second.mode).toBe('events')
      if (second.mode !== 'events') throw new Error('expected events')
      expect(second.events.some((e) => e.type === 'run.settled' && e.runId === 'run-1')).toBe(true)
      expect(second.seq).toBeGreaterThan(first.seq)

      // No new events -> idle mode
      const third = await engine.subscribe(peer, {
        views: ['sessions', 'activeRuns'],
        known: { hostId: second.hostId, logId: second.logId, seq: second.seq },
        waitMs: 0
      })
      expect(third.mode).toBe('idle')
      expect(third.seq).toBe(second.seq)
    } finally {
      hub.close()
      sink.close()
    }
  })

  it('wakes parked subscribe immediately upon EventSink commit without tick', async () => {
    const dir = makeDir()
    const sink = EventSink.open({ userDataDir: dir, fullfsync: false, maxActiveRuns: 64 })
    const hub = new SubscribeHub()
    sink.setCommitObserver((seq) => hub.notifyCommit(seq))
    const engine = new SubscribeEngine({
      sink,
      hub,
      hostId: 'host-wake',
      authorizePeer: () => undefined,
      grantScope: () => 'local'
    })
    try {
      const peer = 'b'.repeat(64)
      const init = await engine.subscribe(peer, { views: ['activeRuns'], waitMs: 0 })
      const started = performance.now()
      const waiting = engine.subscribe(peer, {
        views: ['activeRuns'],
        known: { hostId: init.hostId, logId: init.logId, seq: init.seq },
        waitMs: 5_000
      })
      setTimeout(() => {
        submitRun(sink, { commandId: 'c-wake', runId: 'run-wake', sessionKey: 'sess-w', cwd: '/tmp/w', dispatchImmediately: true })
      }, 20)
      const reply = await waiting
      const elapsed = performance.now() - started
      expect(reply.mode).toBe('events')
      expect(elapsed).toBeLessThan(500)
    } finally {
      hub.close()
      sink.close()
    }
  })

  it('falls back to snapshot on hostId/logId mismatch, seq ahead, pruned_through, >128 events, or >4096 gap', async () => {
    const dir = makeDir()
    const sink = EventSink.open({ userDataDir: dir, fullfsync: false, maxActiveRuns: 256 })
    const hub = new SubscribeHub()
    const engine = new SubscribeEngine({
      sink,
      hub,
      hostId: 'host-snap',
      authorizePeer: () => undefined,
      grantScope: () => 'local'
    })
    try {
      const peer = 'c'.repeat(64)
      submitRun(sink, { commandId: 'c-s1', runId: 'run-s1', sessionKey: 'sess-s1', cwd: '/tmp/s1', dispatchImmediately: true })
      const base = await engine.subscribe(peer, { views: ['activeRuns'], waitMs: 0 })

      const wrongHost = await engine.subscribe(peer, {
        views: ['activeRuns'],
        known: { hostId: 'other-host', logId: base.logId, seq: base.seq },
        waitMs: 0
      })
      expect(wrongHost.mode).toBe('snapshot')

      const wrongLog = await engine.subscribe(peer, {
        views: ['activeRuns'],
        known: { hostId: base.hostId, logId: 'other-log', seq: base.seq },
        waitMs: 0
      })
      expect(wrongLog.mode).toBe('snapshot')

      const ahead = await engine.subscribe(peer, {
        views: ['activeRuns'],
        known: { hostId: base.hostId, logId: base.logId, seq: base.seq + 99 },
        waitMs: 0
      })
      expect(ahead.mode).toBe('snapshot')

      // >128 relevant events -> snapshot
      for (let i = 0; i < 65; i++) {
        submitRun(sink, { commandId: `c-bulk-${i}`, runId: `run-bulk-${i}`, sessionKey: `sess-b-${i}`, cwd: '/tmp/b', dispatchImmediately: true })
      }
      const overflow = await engine.subscribe(peer, {
        views: ['activeRuns'],
        known: { hostId: base.hostId, logId: base.logId, seq: base.seq },
        waitMs: 0
      })
      expect(overflow.mode).toBe('snapshot')
    } finally {
      hub.close()
      sink.close()
    }
  })

  it('coalesces run output hints with 50ms leading edge while delivering hostNotice immediately without coalescing', async () => {
    const dir = makeDir()
    const sink = EventSink.open({ userDataDir: dir, fullfsync: false, maxActiveRuns: 64 })
    const hub = new SubscribeHub({ coalesceMs: 50 })
    const engine = new SubscribeEngine({
      sink,
      hub,
      hostId: 'host-hint',
      authorizePeer: () => undefined,
      grantScope: () => 'local'
    })
    try {
      const peer = 'd'.repeat(64)
      const init = await engine.subscribe(peer, { views: ['activeRuns'], waitMs: 0 })
      const known = { hostId: init.hostId, logId: init.logId, seq: init.seq }

      // Leading edge: first output hint delivers immediately
      hub.noteRunOutput('run-h', 1)
      const h1 = await engine.subscribe(peer, { views: ['activeRuns'], known, waitMs: 0 })
      expect(h1.hints?.filter((h) => h.kind === 'run')).toHaveLength(1)

      // Burst of 5 outputs within 50 ms coalesces into 1 trailing hint with outputSeq=6
      for (let s = 2; s <= 6; s++) hub.noteRunOutput('run-h', s)
      const immediate = await engine.subscribe(peer, { views: ['activeRuns'], known, waitMs: 0 })
      expect(immediate.hints?.filter((h) => h.kind === 'run') ?? []).toHaveLength(0)

      const coalesced = await engine.subscribe(peer, { views: ['activeRuns'], known, waitMs: 300 })
      const runHints = coalesced.hints?.filter((h) => h.kind === 'run') ?? []
      expect(runHints).toHaveLength(1)
      expect(runHints[0]).toMatchObject({ kind: 'run', runId: 'run-h', outputSeq: 6 })

      // W11 hostNotice hints are NEVER coalesced and arrive immediately
      hub.emitHostNotice({
        id: 'n1', kind: 'cli_approval_enabled', ts: 1
      })
      hub.emitHostNotice({
        id: 'n2', kind: 'device_approved_via_cli', ts: 2, deviceLabel: 'Phone'
      })
      const notices = await engine.subscribe(peer, { views: ['activeRuns'], known, waitMs: 0 })
      const hostNotices = notices.hints?.filter((h) => h.kind === 'hostNotice') ?? []
      expect(hostNotices).toHaveLength(2)
    } finally {
      hub.close()
      sink.close()
    }
  })

  it.each(['local', 'remote'] as const)('paginates %s sessions without dropping a notice or duplicating on concurrent insert', async (scope) => {
    const dir = makeDir()
    const sink = EventSink.open({ userDataDir: dir, fullfsync: false, maxActiveRuns: 64 })
    const hub = new SubscribeHub()
    const engine = new SubscribeEngine({
      sink,
      hub,
      hostId: 'host-page',
      authorizePeer: () => undefined,
      grantScope: () => scope,
      remoteCwdAuthorizer: () => cwd => cwd === '/tmp/p',
      remoteHostNotices: true,
      sessionsPageSize: 2
    })
    try {
      const peer = 'e'.repeat(64)
      submitRun(sink, { commandId: 'p1', runId: 'r1', sessionKey: 's1', cwd: '/tmp/p', at: 1000 })
      submitRun(sink, { commandId: 'p2', runId: 'r2', sessionKey: 's2', cwd: '/tmp/p', at: 2000 })
      submitRun(sink, { commandId: 'p3', runId: 'r3', sessionKey: 's3', cwd: '/tmp/p', at: 3000 })

      const page1 = await engine.subscribe(peer, { views: ['sessions'], waitMs: 0 })
      expect(page1.mode).toBe('snapshot')
      if (page1.mode !== 'snapshot') throw new Error('expected snapshot')
      expect(page1.snapshot.sessions?.rows.map((r) => r.sessionKey)).toEqual(['s3', 's2'])
      expect(page1.snapshot.sessions?.nextCursor).toBeTruthy()

      // Insert a newer session before fetching page 2
      submitRun(sink, { commandId: 'p4', runId: 'r4', sessionKey: 's4', cwd: '/tmp/p', at: 4000 })
      const notice = { id: 'between-pages', kind: 'cli_approval_enabled' as const, ts: 4500 }
      hub.emitHostNotice(notice)
      const page2 = await engine.subscribe(peer, {
        views: ['sessions'],
        sessionsCursor: page1.snapshot.sessions!.nextCursor,
        waitMs: 0
      })
      expect(page2.mode).toBe('snapshot')
      if (page2.mode !== 'snapshot') throw new Error('expected snapshot')
      expect(page2.snapshot.sessions?.rows.map((r) => r.sessionKey)).toEqual(['s1'])
      expect(page2.snapshot.sessions?.nextCursor).toBeUndefined()
      expect(page2.hints).toBeUndefined()
      const tail = await engine.subscribe(peer, { views: ['sessions', 'activeRuns'], waitMs: 0,
        known: { hostId: page1.hostId, logId: page1.logId, seq: page1.seq }
      })
      expect(tail).toMatchObject({ hints: [{ kind: 'hostNotice', notice }] })
    } finally {
      hub.close()
      sink.close()
    }
  })

  it('delivers one host notice to both the desktop device and its forwarded subscriber', async () => {
    const sink = EventSink.open({ userDataDir: makeDir(), fullfsync: false })
    const hub = new SubscribeHub()
    const engine = new SubscribeEngine({
      sink, hub, hostId: 'host', authorizePeer: () => undefined, grantScope: () => 'remote', remoteHostNotices: true
    })
    try {
      const request = { views: ['sessions', 'activeRuns'] as const, waitMs: 0 }
      const frame = { ...request, views: [...request.views] }
      const forwarded = { ...frame, subscriptionId: 'f'.repeat(32) }
      const peer = 'b'.repeat(64)
      const first = await engine.subscribe(peer, frame)
      await engine.subscribe(peer, forwarded)
      const known = { hostId: first.hostId, logId: first.logId, seq: first.seq }
      const notice = { id: 'shared-notice', kind: 'cli_approval_enabled' as const, ts: 1 }
      hub.emitHostNotice(notice)
      const desktop = await engine.subscribe(peer, { ...frame, known })
      const phone = await engine.subscribe(peer, { ...forwarded, known })
      expect(desktop.hints).toEqual([{ kind: 'hostNotice', notice }])
      expect(phone.hints).toEqual([{ kind: 'hostNotice', notice }])
    } finally {
      hub.close()
      sink.close()
    }
  })

  it('always includes every live run in the snapshot, however many runs ended recently', async () => {
    const dir = makeDir()
    const sink = EventSink.open({ userDataDir: dir, fullfsync: false, maxActiveRuns: 64 })
    const hub = new SubscribeHub({})
    const engine = new SubscribeEngine({ sink, hub, hostId: 'host-cap', authorizePeer: () => undefined, grantScope: () => 'local' })
    try {
      submitRun(sink, { commandId: 'c-live', runId: 'run-live', sessionKey: 'sess-live', cwd: '/tmp/ws', dispatchImmediately: true })
      for (let i = 0; i < 300; i++) {
        submitRun(sink, { commandId: `c-${i}`, runId: `run-${i}`, sessionKey: `sess-${i}`, cwd: '/tmp/ws', dispatchImmediately: true })
        settleRun(sink, `run-${i}`)
      }
      const reply = await engine.subscribe('e'.repeat(64), { views: ['activeRuns'], waitMs: 0 })
      if (reply.mode !== 'snapshot') throw new Error('expected snapshot')
      const rows = reply.snapshot.activeRuns?.rows ?? []
      expect(rows.some((row) => row.runId === 'run-live')).toBe(true)
      expect(rows.filter((row) => row.runId !== 'run-live')).toHaveLength(256)
    } finally {
      hub.close()
      sink.close()
    }
  })

  it('gives a fresh subscriber the current state only, never a replay of old volatile hints', async () => {
    const dir = makeDir()
    const sink = EventSink.open({ userDataDir: dir, fullfsync: false, maxActiveRuns: 64 })
    const hub = new SubscribeHub({
      stateHints: () => [{ kind: 'attention', snapshot: { revision: 1, unreadSessionKeys: [] } }]
    })
    const engine = new SubscribeEngine({ sink, hub, hostId: 'host-fresh', authorizePeer: () => undefined, grantScope: () => 'local' })
    try {
      const peer = 'f'.repeat(64)
      hub.emitHostNotice({ id: 'old-1', kind: 'cli_approval_enabled', ts: 1 })
      const fresh = await engine.subscribe(peer, { views: ['activeRuns'], waitMs: 0 })
      expect(fresh.hints?.some((h) => h.kind === 'hostNotice') ?? false).toBe(false)
      expect(fresh.hints?.some((h) => h.kind === 'attention')).toBe(true)
      // After that first reply, new hints are delivered normally.
      hub.emitHostNotice({ id: 'new-1', kind: 'device_approved_via_cli', ts: 2, deviceLabel: 'Phone' })
      const next = await engine.subscribe(peer, {
        views: ['activeRuns'], known: { hostId: fresh.hostId, logId: fresh.logId, seq: fresh.seq }, waitMs: 0
      })
      const notices = next.hints?.filter((h) => h.kind === 'hostNotice') ?? []
      expect(notices).toHaveLength(1)
      // An App restart is a fresh subscriber again: the delivered notice is not replayed.
      hub.emitHostNotice({ id: 'missed-1', kind: 'cli_approval_enabled', ts: 3 })
      const restarted = await engine.subscribe(peer, { views: ['activeRuns'], waitMs: 0 })
      expect(restarted.hints?.some((h) => h.kind === 'hostNotice') ?? false).toBe(false)
    } finally {
      hub.close()
      sink.close()
    }
  })
})
