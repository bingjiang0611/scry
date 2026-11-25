import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { voidExpiredEffects } from './effect-outbox'
import { sessionQueueBlocksDispatch } from '../../daemon/orchestration-dispatch-queue'
import type { OrchestrationCommand } from './orchestrator-commands'

const PEER_A = `peer:${'a'.repeat(64)}`

function submit(input: { commandId: string; runId: string; claimMode: 'immediate' | 'queued'; at?: number }): OrchestrationCommand {
  const payload = {
    runId: input.runId,
    sessionKey: 'sess-d1',
    provider: 'claude' as const,
    profile: 'default',
    cwd: '/tmp/ws',
    promptPreview: 'queued turn',
    claimMode: input.claimMode,
    leaseOwner: 'daemon-1'
  }
  return {
    type: 'run.submit',
    commandId: input.commandId,
    actor: PEER_A,
    scope: 'local',
    at: input.at ?? 1_700_000_000_000,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  }
}

function effect(commandId: string, runId: string, step: 'settled' | 'dispatched', at: number): OrchestrationCommand {
  const payload = { runId, step }
  return {
    type: 'run.effect_result',
    commandId,
    actor: 'effect:provider.run.start',
    scope: 'system',
    at,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  }
}

it('D1: a queued run survives a restart with its position and stays queued', () => {
  const userData = mkdtempSync(join(tmpdir(), 'scry-d1-queue-'))
  try {
    let sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
    expect(sink.execute(submit({ commandId: 'c1', runId: 'run-live', claimMode: 'immediate' })).kind).toBe('accepted')
    expect(sink.execute(effect('c-dispatch', 'run-live', 'dispatched', 1_700_000_000_010)).kind).toBe('accepted')
    expect(sink.execute(submit({ commandId: 'c2', runId: 'run-queued', claimMode: 'queued' })).kind).toBe('accepted')
    expect(sink.getRun('run-queued')).toMatchObject({ lifecycle: 'queued', queuePosition: 1 })
    sink.close()

    sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
    try {
      // The queue is host state, so a restart reads the same entry instead of an empty renderer.
      expect(sink.getRun('run-queued')).toMatchObject({ lifecycle: 'queued', queuePosition: 1 })
      expect(sink.getRun('run-live')?.lifecycle).toBe('dispatched')
    } finally {
      sink.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

it('D1: once the live run settles the queued run is dispatchable', () => {
  const userData = mkdtempSync(join(tmpdir(), 'scry-d1-drain-'))
  const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
  try {
    sink.execute(submit({ commandId: 'c1', runId: 'run-live', claimMode: 'immediate' }))
    sink.execute(effect('c-dispatch', 'run-live', 'dispatched', 1_700_000_000_010))
    sink.execute(submit({ commandId: 'c2', runId: 'run-queued', claimMode: 'queued' }))
    // While the head is live the queued run must defer, not dispatch.
    expect(sessionQueueBlocksDispatch(sink, 'run-queued')).toBe(true)

    sink.execute(effect('c-settle', 'run-live', 'settled', 1_700_000_000_100))
    expect(sink.getRun('run-live')?.lifecycle).toBe('settled')
    // Nothing else of the session is live, so the queued run is free to dispatch.
    expect(sessionQueueBlocksDispatch(sink, 'run-queued')).toBe(false)
  } finally {
    sink.close()
    rmSync(userData, { recursive: true, force: true })
  }
})

// B3 (review): the projection has to make the hold real, not just record a flag nobody reads.
it('D1: a held run does not dispatch, and dispatches after the release', () => {
  const userData = mkdtempSync(join(tmpdir(), 'scry-d1-held-'))
  try {
    const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
    try {
      expect(sink.execute(submit({ commandId: 'h1', runId: 'run-live', claimMode: 'immediate' })).kind).toBe('accepted')
      expect(sink.execute(effect('h-dispatch', 'run-live', 'dispatched', 1_700_000_000_010)).kind).toBe('accepted')
      expect(sink.execute(submit({ commandId: 'h2', runId: 'run-queued', claimMode: 'queued' })).kind).toBe('accepted')
      expect(sessionQueueBlocksDispatch(sink, 'run-queued')).toBe(true)

      // Stopping the live run holds the queued one: that is the promise the copy makes.
      const stopPayload = { runId: 'run-live' }
      expect(sink.execute({
        type: 'run.stop', commandId: 'h3', actor: PEER_A, scope: 'local', at: 1_700_000_000_020,
        payload: stopPayload, payloadSha256: sha256Hex(canonicalJson(stopPayload))
      }).kind).toBe('accepted')
      expect(sink.execute(effect('h-settle', 'run-live', 'settled', 1_700_000_000_030)).kind).toBe('accepted')
      expect(sink.getRun('run-queued')).toMatchObject({ lifecycle: 'queued', queueHeld: true })
      // The live run is gone, so the only thing keeping it back is the hold.
      expect(sessionQueueBlocksDispatch(sink, 'run-queued')).toBe(true)

      const releasePayload = { runId: 'run-queued' }
      const released = sink.execute({
        type: 'run.release_queue', commandId: 'h4', actor: PEER_A, scope: 'local', at: 1_700_000_000_040,
        payload: releasePayload, payloadSha256: sha256Hex(canonicalJson(releasePayload))
      })
      expect(released).toMatchObject({ kind: 'accepted' })
      // The mapper omits a false flag rather than reporting it; either way the hold is gone.
      expect(sink.getRun('run-queued')?.queueHeld ?? false).toBe(false)
      // Releasing does not move the entry: it keeps the slot the user is looking at.
      expect(sink.getRun('run-queued')).toMatchObject({ lifecycle: 'queued', queuePosition: 1 })
      expect(sessionQueueBlocksDispatch(sink, 'run-queued')).toBe(false)
    } finally {
      sink.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

// D1: "用户排的队在重启后保留（不受 pending 的 60 秒 TTL 约束）". A queued submit still carried the
// pending TTL, so a queue that waited a minute was voided as `pending_expired` and its run cancelled.
it('D1: a queued run is not voided by the pending TTL', () => {
  const userData = mkdtempSync(join(tmpdir(), 'scry-d1-ttl-'))
  try {
    const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
    try {
      expect(sink.execute(submit({ commandId: 't1', runId: 'run-live', claimMode: 'immediate' })).kind).toBe('accepted')
      expect(sink.execute(effect('t-dispatch', 'run-live', 'dispatched', 1_700_000_000_010)).kind).toBe('accepted')
      expect(sink.execute(submit({ commandId: 't2', runId: 'run-waiting', claimMode: 'queued' })).kind).toBe('accepted')
      // Two minutes later the queue has not moved yet.
      const expired = voidExpiredEffects(sink.handle.db, 1_700_000_000_000 + 120_000)
      expect(expired.map((row) => row.runId)).not.toContain('run-waiting')
      expect(sink.getRun('run-waiting')).toMatchObject({ lifecycle: 'queued' })
    } finally {
      sink.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

it('D1: two waiting entries do not block each other — the head dispatches, the tail keeps waiting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scry-d1-two-queued-'))
  const sink = EventSink.open({ userDataDir: dir, checkpointIntervalMs: 0, authorizedActors: [PEER_A] })
  try {
    sink.execute(submit({ commandId: 'c1', runId: 'run-head', claimMode: 'queued', at: 1_700_000_000_000 }))
    sink.execute(submit({ commandId: 'c2', runId: 'run-tail', claimMode: 'queued', at: 1_700_000_000_001 }))
    // Nothing is running yet: waiting behind another *waiting* entry is not a reason to defer, or the
    // session can never start anything. Order is kept by the outbox's own same-session FIFO.
    expect(sessionQueueBlocksDispatch(sink, 'run-head')).toBe(false)

    sink.execute(effect('c-dispatch', 'run-head', 'dispatched', 1_700_000_000_010))
    // Now the head is live, so the tail must wait for it.
    expect(sink.getRun('run-head')?.lifecycle).toBe('dispatched')
    expect(sessionQueueBlocksDispatch(sink, 'run-tail')).toBe(true)

    sink.execute(effect('c-settle', 'run-head', 'settled', 1_700_000_000_100))
    expect(sessionQueueBlocksDispatch(sink, 'run-tail')).toBe(false)
  } finally {
    sink.close()
  }
})

// R11: stopping a run that is still waiting for its slot held the whole session queue and left that run
// `queued` forever, so the user's stop did nothing and every sibling stalled behind it.
it('R11: stopping a queued run cancels that run and leaves its siblings queued', () => {
  const userData = mkdtempSync(join(tmpdir(), 'scry-r11-stop-queued-'))
  try {
    const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
    try {
      expect(sink.execute(submit({ commandId: 'r1', runId: 'run-live', claimMode: 'immediate' })).kind).toBe('accepted')
      expect(sink.execute(effect('r-dispatch', 'run-live', 'dispatched', 1_700_000_000_010)).kind).toBe('accepted')
      expect(sink.execute(submit({ commandId: 'r2', runId: 'run-first', claimMode: 'queued' })).kind).toBe('accepted')
      expect(sink.execute(submit({ commandId: 'r3', runId: 'run-second', claimMode: 'queued' })).kind).toBe('accepted')

      const stopPayload = { runId: 'run-first' }
      const stopped = sink.execute({
        type: 'run.stop', commandId: 'r4', actor: PEER_A, scope: 'local', at: 1_700_000_000_020,
        payload: stopPayload, payloadSha256: sha256Hex(canonicalJson(stopPayload))
      })
      expect(stopped).toMatchObject({ kind: 'accepted' })
      expect(sink.getRun('run-first')?.lifecycle).toBe('cancelled')
      // The sibling keeps its place and is not held: the stop only ever named one run.
      expect(sink.getRun('run-second')).toMatchObject({ lifecycle: 'queued', queuePosition: 2 })
      expect(sink.getRun('run-second')?.queueHeld ?? false).toBe(false)
      // Nothing left to stop for a run that never started, so no stop effect is queued for it.
      const stopEffects = sink.handle.db
        .prepare("SELECT COUNT(*) AS n FROM orch_outbox WHERE run_id = 'run-first' AND kind = 'provider.run.stop'")
        .get() as { n: number }
      expect(stopEffects.n).toBe(0)
      expect(sink.getRun('run-live')?.lifecycle).toBe('dispatched')
    } finally {
      sink.close()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
