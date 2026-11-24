import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
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
