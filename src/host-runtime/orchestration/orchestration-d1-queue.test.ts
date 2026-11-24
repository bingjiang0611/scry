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
