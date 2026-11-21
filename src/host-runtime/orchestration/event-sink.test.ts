import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunRegistry, type RunRegistryControl, type RunRegistryState } from '../../main/run-registry'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { INLINE_BODY_MAX_BYTES } from './types'
import type { OrchestrationCommand } from './orchestrator-commands'

const PEER_A = `peer:${'a'.repeat(64)}`

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-sink-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeSubmit(
  sink: EventSink,
  overrides: {
    commandId: string
    runId: string
    sessionKey: string
    prompt: string
    at?: number
    ordinal?: number
  }
): OrchestrationCommand {
  const body = sink.bodyStore.prepareBody(overrides.prompt)
  const payload = {
    runId: overrides.runId,
    sessionKey: overrides.sessionKey,
    ordinal: overrides.ordinal ?? 1,
    provider: 'claude',
    profile: 'default',
    cwd: '/tmp/ws',
    promptPreview: overrides.prompt.slice(0, 200),
    userTextPreview: overrides.prompt.slice(0, 512),
    body,
    claimMode: 'immediate' as const,
    leaseOwner: 'daemon-1'
  }
  return {
    type: 'run.submit',
    commandId: overrides.commandId,
    actor: PEER_A,
    scope: 'remote',
    at: overrides.at ?? 1_700_000_000_000,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  }
}

describe('P4-0 EventSink atomic commits, fail closed, deletion, pruning, and replay', () => {
  it('commits events, projections, receipts, and outbox atomically and matches replay from empty', () => {
    withTempDir((userData) => {
      const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
      try {
        const createCmd: OrchestrationCommand = {
          type: 'session.create',
          commandId: 'cmd-create-1',
          actor: PEER_A,
          scope: 'remote',
          at: 1_700_000_000_000,
          payload: { sessionKey: 'sess-1', provider: 'claude', profile: 'default', cwd: '/tmp/ws', title: 'Alpha' },
          payloadSha256: sha256Hex('cmd-create-1')
        }
        expect(sink.execute(createCmd).kind).toBe('accepted')

        const sub = makeSubmit(sink, {
          commandId: 'cmd-run-1',
          runId: 'remote-run-1',
          sessionKey: 'sess-1',
          prompt: 'hello world',
          at: 1_700_000_001_000
        })
        const r1 = sink.execute(sub)
        expect(r1.kind).toBe('accepted')
        expect(sink.getRun('remote-run-1')?.outputSeq).toBeNull()

        // Re-importing or updating session metadata must preserve active_run_id & pending_questions
        expect(
          sink.execute({
            type: 'run.effect_result',
            commandId: 'effect:e1:admitted_and_dispatched',
            actor: 'effect:e1',
            scope: 'system',
            at: 1_700_000_002_000,
            payload: { runId: 'remote-run-1', step: 'admitted_and_dispatched' },
            payloadSha256: sha256Hex('barrier')
          }).kind
        ).toBe('accepted')
        expect(
          sink.execute({
            type: 'run.effect_result',
            commandId: 'effect:e1:q1',
            actor: 'effect:e1',
            scope: 'system',
            at: 1_700_000_002_500,
            payload: {
              runId: 'remote-run-1',
              step: 'question_opened',
              questionId: 'q-1',
              questionKind: 'approval',
              questionSource: 'provider'
            },
            payloadSha256: sha256Hex('q1')
          }).kind
        ).toBe('accepted')
        expect(
          sink.execute({
            type: 'session.import',
            commandId: 'imp-preserve',
            actor: 'system',
            scope: 'system',
            at: 1_700_000_002_600,
            payload: { sessionKey: 'sess-1', ts: 1_700_000_002_600, title: 'Alpha Updated' },
            payloadSha256: sha256Hex('imp-preserve')
          }).kind
        ).toBe('accepted')
        const preserved = sink.getSession('sess-1')
        expect(preserved?.title).toBe('Alpha Updated')
        expect(preserved?.activeRunId).toBe('remote-run-1')
        expect(preserved?.pendingQuestions).toBe(1)

        // Idempotent replay of identical commandId returns same receipt, no duplicate events/outbox
        const r1Dup = sink.execute(sub)
        expect(r1Dup.kind).toBe('duplicate')
        expect(sink.listEvents().filter((e) => e.type === 'run.intent_recorded')).toHaveLength(1)

        // Settle
        const settled: OrchestrationCommand = {
          type: 'run.effect_result',
          commandId: 'effect:e1:settled',
          actor: 'effect:e1',
          scope: 'system',
          at: 1_700_000_003_000,
          payload: { runId: 'remote-run-1', step: 'settled', evidence: ['provider-result:remote-run-1'] },
          payloadSha256: sha256Hex('settled')
        }
        expect(sink.execute(settled).kind).toBe('accepted')

        const run = sink.getRun('remote-run-1')
        expect(run?.lifecycle).toBe('settled')
        expect(run?.settledAt).toBe(1_700_000_003_000)

        const turn = sink.getTurn('sess-1', 1)
        expect(turn?.delivery).toBe('accepted')
        expect(turn?.author).toBe('user')

        // Projection replay from empty equals online projection field-for-field including rev_seq
        const replayCheck = sink.verifyReplayConsistency()
        expect(replayCheck.matches).toBe(true)
      } finally {
        sink.close()
      }
    })
  })

  it('rolls back atomically on injected failure, fences fail-closed, and still allows stop bypass with R5 cascade', () => {
    withTempDir((userData) => {
      let shouldFail = false
      const sink = EventSink.open({
        userDataDir: userData,
        authorizedActors: [PEER_A],
        beforeCommitHook: () => {
          if (shouldFail) {
            const err = Object.assign(new Error('SQLITE_IOERR_FSYNC'), { code: 'SQLITE_IOERR_FSYNC' })
            throw err
          }
        }
      })
      try {
        expect(
          sink.execute(
            makeSubmit(sink, { commandId: 'c1', runId: 'run-1', sessionKey: 'sess-1', prompt: 'ok' })
          ).kind
        ).toBe('accepted')

        const eventsBefore = sink.listEvents().length
        shouldFail = true

        expect(() =>
          sink.execute(
            makeSubmit(sink, { commandId: 'c2', runId: 'run-2', sessionKey: 'sess-2', prompt: 'boom' })
          )
        ).toThrow(expect.objectContaining({ code: 'orchestration_write_indeterminate' }))

        // Fence is active: new writes rejected retryably, reads throw unavailable
        expect(sink.isWriteIndeterminate()).toBe(true)
        const afterFence = sink.execute(
          makeSubmit(sink, { commandId: 'c3', runId: 'run-3', sessionKey: 'sess-3', prompt: 'blocked' })
        )
        expect(afterFence).toEqual({
          kind: 'rejected',
          reason: 'orchestration_write_indeterminate',
          sticky: false,
          writeReceipt: false
        })
        expect(() => sink.getRun('run-1')).toThrow(
          expect.objectContaining({ code: 'orchestration_write_indeterminate' })
        )

        // Tightening-only stop STILL works while fenced, and cascades via memory RunRegistry.parentRunId (R5)
        const registry = new RunRegistry<RunRegistryState, RunRegistryControl>()
        registry.register({ runId: 'run-1', done: false }, { runId: 'run-1' })
        registry.register({ runId: 'run-1-child', done: false, parentRunId: 'run-1' }, { runId: 'run-1-child' })
        const stopped: string[] = []
        const stopFn = vi.fn((control: RunRegistryControl) => {
          stopped.push(control.runId)
        })

        const bypassed = sink.stopRunBypassingFence('run-1', registry, stopFn)
        expect(bypassed).toEqual(['run-1', 'run-1-child'])
        expect(stopped).toEqual(['run-1', 'run-1-child'])

        sink.close()

        // Reopening clears fence; verify transaction rolled back cleanly (no run-2, no partial events)
        const reopened = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
        try {
          expect(reopened.isWriteIndeterminate()).toBe(false)
          expect(reopened.listEvents().length).toBe(eventsBefore)
          expect(reopened.getRun('run-2')).toBeUndefined()
          expect(reopened.getReceipt('c2', PEER_A)).toBeUndefined()
        } finally {
          reopened.close()
        }
      } finally {
        sink.close()
      }
    })
  })

  it('fences fail-closed on genuine SQLite SQLITE_FULL commit failure without any JS hook', () => {
    withTempDir((userData) => {
      const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
      try {
        expect(
          sink.execute(makeSubmit(sink, { commandId: 'full-1', runId: 'run-full-1', sessionKey: 's-full-1', prompt: 'ok' })).kind
        ).toBe('accepted')

        const eventsBefore = sink.listEvents().length
        const currentPages = Number(sink.handle.db.pragma('page_count', { simple: true }))
        // Cap DB growth at current page_count so SQLite itself raises SQLITE_FULL during write
        sink.handle.db.pragma(`max_page_count = ${currentPages}`)

        const chunk = 'Z'.repeat(8_000)
        let caught: unknown = null
        let failedRunId = ''
        for (let i = 0; i < 40; i += 1) {
          failedRunId = `run-full-overflow-${i}`
          try {
            sink.execute(
              makeSubmit(sink, {
                commandId: `full-overflow-${i}`,
                runId: failedRunId,
                sessionKey: `s-full-overflow-${i}`,
                prompt: `${i}:${chunk}`
              })
            )
          } catch (error) {
            caught = error
            break
          }
        }

        expect(caught).toMatchObject({ code: 'orchestration_write_indeterminate' })
        expect(String((caught as Error).message)).toMatch(/full/i)
        expect(sink.isWriteIndeterminate()).toBe(true)

        // Subsequent command is rejected retryably while fenced
        expect(
          sink.execute(makeSubmit(sink, { commandId: 'after-full', runId: 'run-after', sessionKey: 's-after', prompt: 'x' }))
        ).toEqual({
          kind: 'rejected',
          reason: 'orchestration_write_indeterminate',
          sticky: false,
          writeReceipt: false
        })

        // Tightening-only stop still works while fenced
        const registry = new RunRegistry<RunRegistryState, RunRegistryControl>()
        registry.register({ runId: 'run-full-1', done: false }, { runId: 'run-full-1' })
        const stopped: string[] = []
        expect(sink.stopRunBypassingFence('run-full-1', registry, (c) => stopped.push(c.runId))).toEqual(['run-full-1'])
        expect(stopped).toEqual(['run-full-1'])

        sink.close()

        // Reopen without page cap: failed transaction must have rolled back atomically
        const reopened = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
        try {
          expect(reopened.getRun(failedRunId)).toBeUndefined()
          expect(reopened.listEvents().length).toBeGreaterThanOrEqual(eventsBefore)
          expect(reopened.verifyReplayConsistency()).toEqual({ matches: true })
        } finally {
          reopened.close()
        }
      } finally {
        sink.close()
      }
    })
  })

  it('deletes session projection/outbox, redacts event previews, and unlinks unreferenced external bodies', () => {
    withTempDir((userData) => {
      const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
      try {
        const bigPromptA = 'A'.repeat(INLINE_BODY_MAX_BYTES + 200)
        const sharedBigPrompt = 'S'.repeat(INLINE_BODY_MAX_BYTES + 200)

        const subA = makeSubmit(sink, { commandId: 'ca', runId: 'run-a', sessionKey: 'sess-a', prompt: bigPromptA })
        const subShared1 = makeSubmit(sink, {
          commandId: 'cs1',
          runId: 'run-s1',
          sessionKey: 'sess-a',
          prompt: sharedBigPrompt,
          ordinal: 2
        })
        const subShared2 = makeSubmit(sink, {
          commandId: 'cs2',
          runId: 'run-s2',
          sessionKey: 'sess-b',
          prompt: sharedBigPrompt
        })

        expect(sink.execute(subA).kind).toBe('accepted')
        // Settle run-a so sess-a can start a second run
        expect(
          sink.execute({
            type: 'run.effect_result',
            commandId: 'effect:ea:cancelled',
            actor: 'effect:ea',
            scope: 'system',
            at: 1_700_000_001_000,
            payload: { runId: 'run-a', step: 'cancelled', reason: 'done' },
            payloadSha256: sha256Hex('ea-cancel')
          }).kind
        ).toBe('accepted')
        expect(sink.execute(subShared1).kind).toBe('accepted')
        expect(sink.execute(subShared2).kind).toBe('accepted')

        const shaA = sha256Hex(bigPromptA)
        const shaShared = sha256Hex(sharedBigPrompt)
        expect(sink.bodyStore.hasExternalBody(shaA)).toBe(true)
        expect(sink.bodyStore.hasExternalBody(shaShared)).toBe(true)

        const delResult = sink.deleteSession({
          sessionKey: 'sess-a',
          cwd: '/tmp/ws',
          actor: PEER_A,
          scope: 'remote',
          at: 1_700_000_010_000
        })
        expect(delResult.status).toBe('deleted')
        expect(sink.getSession('sess-a')).toBeUndefined()
        expect(sink.getRun('run-a')).toBeUndefined()
        expect(sink.getTurn('sess-a', 1)).toBeUndefined()

        // Exclusive body for sess-a is unlinked; shared body still referenced by sess-b stays!
        expect(sink.bodyStore.hasExternalBody(shaA)).toBe(false)
        expect(sink.bodyStore.hasExternalBody(shaShared)).toBe(true)

        // Historical event previews for sess-a are redacted; session.deleted tombstone preserves cwd
        const sessAEvents = sink.listEvents().filter((e) => e.sessionKey === 'sess-a')
        const tombstone = sessAEvents.find((e) => e.type === 'session.deleted')
        expect(tombstone?.cwd).toBe('/tmp/ws')
        for (const evt of sessAEvents.filter((e) => e.type !== 'session.deleted')) {
          expect(evt.payload).toEqual({ redacted: true })
        }

        // Deleting non-existent session returns not_present
        expect(
          sink.deleteSession({
            sessionKey: 'sess-never-existed',
            cwd: '/tmp/ws',
            actor: PEER_A,
            scope: 'remote',
            at: 1_700_000_011_000
          }).status
        ).toBe('not_present')
      } finally {
        sink.close()
      }
    })
  })

  it('prunes old events while keeping latest per stream and NEVER pruning receipts', () => {
    withTempDir((userData) => {
      const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER_A] })
      try {
        expect(
          sink.execute(
            makeSubmit(sink, {
              commandId: 'old-cmd',
              runId: 'old-run',
              sessionKey: 'old-sess',
              prompt: 'old',
              at: 1_000
            })
          ).kind
        ).toBe('accepted')
        expect(
          sink.execute({
            type: 'run.effect_result',
            commandId: 'effect:old:cancelled',
            actor: 'effect:old',
            scope: 'system',
            at: 2_000,
            payload: { runId: 'old-run', step: 'cancelled', reason: 'done' },
            payloadSha256: sha256Hex('old-cancel')
          }).kind
        ).toBe('accepted')

        const pruned = sink.pruneEvents({ olderThanAt: 5_000 })
        expect(pruned.deletedEvents).toBeGreaterThan(0)
        expect(pruned.prunedThrough).toBeGreaterThan(0)
        // Latest event per stream stays
        const remaining = sink.listEvents()
        expect(remaining.some((e) => e.stream === 'run:old-run')).toBe(true)
        // Receipt is permanent even after event pruning (data §4.3)
        expect(sink.getReceipt('old-cmd', PEER_A)).toBeDefined()
        expect(sink.getMeta('pruned_through')).toBe(String(pruned.prunedThrough))
      } finally {
        sink.close()
      }
    })
  })
})
