import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConversationStore } from '../../main/conversation-store'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import type { EffectResultStep } from './orchestrator-commands'
import type { Evidence } from '../../shared/turn-record-contracts'
import { writeBackConversationRun } from './recovery'

// A run started from a device or the daemon has no in-process waiter, so its conversation turn stayed
// `pending` until the next daemon restart reconciled it. The writeback now happens at the run's terminal.

async function harness(): Promise<{
  userData: string
  sink: EventSink
  store: ConversationStore
  begin: (runId: string) => Promise<{ conversationId: string }>
  settle: (runId: string) => void
  cleanup: () => void
}> {
  const userData = mkdtempSync(join(tmpdir(), 'scry-writeback-'))
  const ws = join(userData, 'ws')
  mkdirSync(ws, { recursive: true })
  const store = new ConversationStore(userData)
  const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
  const begin = async (runId: string) => {
    const dir = realpathSync(ws)
    submit(runId, dir)
    const conv = await store.create(dir)
    await store.begin(conv.id, {
      runId,
      commandId: `intent-${runId}`,
      payloadHash: 'a'.repeat(64),
      expectedRevision: conv.revision,
      target: { providerId: 'codex', continuationKey: 'codex:default' },
      items: [],
      selectedItems: []
    })
    return { conversationId: conv.id }
  }
  const submit = (runId: string, cwd: string) => {
    const payload = {
      runId, sessionKey: null, provider: 'codex', profile: null, cwd,
      claimMode: 'immediate' as const, pendingTtlMs: 30_000, origin: 'remote' as const
    }
    sink.execute({
      type: 'run.submit', commandId: `cmd-${runId}`, actor: 'system', scope: 'remote', at: 0,
      payload, payloadSha256: sha256Hex(canonicalJson(payload))
    })
  }
  const settle = (runId: string) => {
    const execute = (commandId: string, at: number, payload: { runId: string; step: EffectResultStep; outcome?: Evidence<string>; nativeSessionId?: string }) => sink.execute({
      type: 'run.effect_result',
      commandId,
      actor: 'effect:writeback-test',
      scope: 'system',
      at,
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    execute(`disp-${runId}`, 1, { runId, step: 'admitted_and_dispatched' })
    execute(`bind-${runId}`, 2, { runId, step: 'session_bound', nativeSessionId: 'native-wb-1' })
    execute(`done-${runId}`, 3, {
      runId,
      step: 'settled',
      outcome: { status: 'available', quality: 'exact', source: ['provider:codex'], value: 'settled' }
    })
  }
  return {
    userData, sink, store, begin, settle,
    cleanup: () => {
      sink.close()
      rmSync(userData, { recursive: true, force: true })
    }
  }
}

describe('daemon terminal conversation writeback', () => {
  it('settles the pending turn of a finished run, and does nothing the second time', async () => {
    const h = await harness()
    try {
      const runId = 'run-wb-1'
      const { conversationId } = await h.begin(runId)
      h.settle(runId)

      expect(await writeBackConversationRun({ sink: h.sink, conversationStore: h.store, runId })).toBe('written')
      const conv = await h.store.required(conversationId)
      const turn = conv.turns[0]
      expect(turn?.origin === 'dispatch' ? turn.delivery.status : null).toBe('accepted')
      expect(conv.bindings.find((binding) => binding.id === turn?.bindingId)?.nativeSessionId).toBe('native-wb-1')

      // Idempotent: the turn is no longer pending, so a second terminal or a restart writes nothing.
      expect(await writeBackConversationRun({ sink: h.sink, conversationStore: h.store, runId })).toBe('none')
    } finally {
      h.cleanup()
    }
  })

  it('leaves a run that has not reached a terminal state alone', async () => {
    const h = await harness()
    try {
      const runId = 'run-wb-2'
      const { conversationId } = await h.begin(runId)
      // No terminal event yet: a pending turn is the truth, not something to conclude.
      expect(await writeBackConversationRun({ sink: h.sink, conversationStore: h.store, runId })).toBe('none')
      const conv = await h.store.required(conversationId)
      expect(conv.turns[0]?.origin === 'dispatch' ? conv.turns[0].delivery.status : null).toBe('pending')
    } finally {
      h.cleanup()
    }
  })

  it('ignores a run that has no conversation turn at all', async () => {
    const h = await harness()
    try {
      expect(await writeBackConversationRun({ sink: h.sink, conversationStore: h.store, runId: 'never-seen' })).toBe('none')
    } finally {
      h.cleanup()
    }
  })
})
