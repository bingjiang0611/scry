import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLedger } from '../../main/remote/session-ledger'
import { canonicalJson, sha256Hex } from './canonical-json'
import { openOrchestrationDatabase } from './db'
import { EventSink } from './event-sink'
import { loadLegacyLedgerPlan, loadLegacyLedgerPlanAsync, startDeferredLegacyImport } from './legacy-import'
import { readLegacyLedgerAsync, readLegacyLedgerReadOnly } from './legacy-ledger-reader'
import { ShadowMirror } from './shadow-mirror'
import { INLINE_BODY_MAX_BYTES, OrchestrationStoreError } from './types'

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p4-2-gaps-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withTempDirAsync<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p4-2-gaps-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('P4-2 gap 1: WAL checkpoint off the commit critical path', () => {
  it('disables wal_autocheckpoint on open and checkpoints explicitly off-commit', () => {
    withTempDir((userData) => {
      const handle = openOrchestrationDatabase({ userDataDir: userData })
      try {
        expect(handle.db.pragma('wal_autocheckpoint', { simple: true })).toBe(0)
        // Write several rows without auto-checkpointing inline
        const ins = handle.db.prepare('INSERT OR REPLACE INTO orch_meta (key, value) VALUES (?, ?)')
        for (let i = 0; i < 10; i += 1) ins.run(`k-${i}`, 'v'.repeat(512))
        const result = handle.checkpointPassive()
        expect(result.busy).toBe(0)
        expect(result.checkpointed).toBeGreaterThanOrEqual(0)
      } finally {
        handle.close()
      }
    })
  })

  it('schedules idle background passive checkpoint in EventSink without blocking commits', async () => {
    await withTempDirAsync(async (userData) => {
      const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 20 })
      try {
        expect(sink.handle.db.pragma('wal_autocheckpoint', { simple: true })).toBe(0)
        const payload = {
          runId: 'run-wal-1',
          sessionKey: 'sess-wal-1',
          ordinal: 1,
          provider: 'codex',
          profile: null,
          cwd: '/tmp/ws',
          claimMode: 'immediate' as const,
          origin: 'remote' as const
        }
        const res = sink.execute({
          type: 'run.submit',
          commandId: 'cmd-wal-1',
          actor: 'system',
          scope: 'remote',
          at: 1_700_000_000_000,
          payload,
          payloadSha256: sha256Hex(canonicalJson(payload))
        })
        expect(res.kind).toBe('accepted')
        // Wait for idle background checkpoint timer to run
        await new Promise((resolve) => setTimeout(resolve, 60))
        const manual = sink.checkpointPassive()
        expect(manual.busy).toBe(0)
      } finally {
        sink.close()
      }
    })
  })
})

describe('P4-2 gap 2: >16 KiB body durable before event reference and deleteSession coordination', () => {
  it('prepares >16 KiB external body asynchronously with 0600 permissions before EventSink commit', async () => {
    await withTempDirAsync(async (userData) => {
      const bigBody = 'A'.repeat(INLINE_BODY_MAX_BYTES + 4096)
      let durableInsideCommit = false
      let preparedSha = ''
      const sink = EventSink.open({
        userDataDir: userData,
        beforeCommitHook: () => {
          if (preparedSha) {
            durableInsideCommit = sink.bodyStore.hasExternalBody(preparedSha)
          }
        }
      })
      try {
        const prepared = await sink.bodyStore.prepareBodyAsync(bigBody)
        expect(prepared.storage).toBe('external')
        expect(prepared.bytes).toBe(Buffer.byteLength(bigBody, 'utf8'))
        preparedSha = prepared.sha256
        expect(statSync(sink.bodyStore.externalPath(prepared.sha256)).mode & 0o777).toBe(0o600)

        const payload = {
          runId: 'run-big-1',
          sessionKey: 'sess-big-1',
          ordinal: 1,
          provider: 'codex',
          profile: null,
          cwd: '/tmp/ws',
          body: prepared,
          claimMode: 'immediate' as const,
          origin: 'remote' as const
        }
        const res = sink.execute(
          {
            type: 'run.submit',
            commandId: 'cmd-big-1',
            actor: 'system',
            scope: 'remote',
            at: 1_700_000_000_000,
            payload,
            payloadSha256: sha256Hex(canonicalJson(payload))
          },
          { requireExternalBodyDurable: true }
        )
        expect(res.kind).toBe('accepted')
        expect(durableInsideCommit).toBe(true)
        expect(sink.bodyStore.readBody(prepared).toString('utf8')).toBe(bigBody)
      } finally {
        sink.close()
      }
    })
  })

  it('rejects commit when requireExternalBodyDurable is set and the external body file is missing', () => {
    withTempDir((userData) => {
      const sink = EventSink.open({ userDataDir: userData })
      try {
        const fakeSha = sha256Hex('never-persisted-body'.repeat(1500))
        const payload = {
          runId: 'run-dangling-1',
          sessionKey: 'sess-dangling-1',
          ordinal: 1,
          provider: 'codex',
          profile: null,
          cwd: '/tmp/ws',
          body: { storage: 'external' as const, sha256: fakeSha, bytes: 30_000 },
          claimMode: 'immediate' as const,
          origin: 'remote' as const
        }
        expect(() =>
          sink.execute(
            {
              type: 'run.submit',
              commandId: 'cmd-dangling-1',
              actor: 'system',
              scope: 'remote',
              at: 1_700_000_000_000,
              payload,
              payloadSha256: sha256Hex(canonicalJson(payload))
            },
            { requireExternalBodyDurable: true }
          )
        ).toThrow(OrchestrationStoreError)
        expect(sink.getRun('run-dangling-1')).toBeUndefined()
      } finally {
        sink.close()
      }
    })
  })

  it('rejects prepared submit and unlinks body if deleteSession races between prepareBodyAsync and execute', async () => {
    await withTempDirAsync(async (userData) => {
      const sink = EventSink.open({ userDataDir: userData })
      try {
        const sessionKey = 'sess-race-del'
        // Seed an earlier run so the session exists before deleteSession
        const seedPayload = {
          runId: 'run-seed-1',
          sessionKey,
          ordinal: 1,
          provider: 'codex',
          profile: null,
          cwd: '/tmp/ws',
          claimMode: 'immediate' as const,
          origin: 'remote' as const
        }
        expect(
          sink.execute({
            type: 'run.submit',
            commandId: 'cmd-seed-1',
            actor: 'system',
            scope: 'remote',
            at: 1_700_000_000_000,
            payload: seedPayload,
            payloadSha256: sha256Hex(canonicalJson(seedPayload))
          }).kind
        ).toBe('accepted')

        const epochBeforePrepare = sink.getSessionDeleteEpoch(sessionKey)
        const bigBody = 'R'.repeat(INLINE_BODY_MAX_BYTES + 2048)
        const prepared = await sink.bodyStore.prepareBodyAsync(bigBody)
        expect(sink.bodyStore.hasExternalBody(prepared.sha256)).toBe(true)

        // Concurrent deleteSession arrives while body was being prepared
        const del = sink.deleteSession({
          sessionKey,
          cwd: '/tmp/ws',
          actor: 'system',
          scope: 'remote',
          at: 1_700_000_000_100
        })
        expect(del.status).toBe('deleted')

        const racePayload = {
          runId: 'run-race-2',
          sessionKey,
          ordinal: 2,
          provider: 'codex',
          profile: null,
          cwd: '/tmp/ws',
          body: prepared,
          claimMode: 'immediate' as const,
          origin: 'remote' as const
        }
        const res = sink.execute(
          {
            type: 'run.submit',
            commandId: 'cmd-race-2',
            actor: 'system',
            scope: 'remote',
            at: 1_700_000_000_200,
            payload: racePayload,
            payloadSha256: sha256Hex(canonicalJson(racePayload))
          },
          { requireExternalBodyDurable: true, expectedSessionDeleteEpoch: epochBeforePrepare }
        )
        expect(res).toMatchObject({ kind: 'rejected', reason: 'session_deleted_during_prepare', sticky: false })
        expect(sink.getRun('run-race-2')).toBeUndefined()
        // Newly prepared orphan body must be unlinked because no surviving run references it
        expect(sink.bodyStore.hasExternalBody(prepared.sha256)).toBe(false)
      } finally {
        sink.close()
      }
    })
  })

  it('prevents ShadowMirror.flushPendingBodies from resurrecting a deleted session body file', () => {
    withTempDir((userData) => {
      const mirror = ShadowMirror.open({ userDataDir: userData })
      try {
        const runId = SessionLedger.newRunId()
        const sessionKey = 'conv-shadow-del'
        const detail = JSON.stringify({
          providerId: 'codex',
          cwd: '/tmp/ws',
          prompt: 'big prompt',
          blob: 'Z'.repeat(INLINE_BODY_MAX_BYTES + 1024),
          conversation: { conversationId: sessionKey, runId, ordinal: 1 }
        })
        mirror.onLedgerEvent({
          seq: 1,
          at: 1_700_000_000_000,
          runId,
          kind: 'intent_recorded',
          intentId: SessionLedger.newIntentId(),
          detail
        })
        const sha = mirror.sink!.getRun(runId)!.body!.sha256
        expect(mirror.sink!.bodyStore.hasExternalBody(sha)).toBe(false)

        // Delete session while body is still queued in memory
        const del = mirror.sink!.deleteSession({
          sessionKey,
          cwd: '/tmp/ws',
          actor: 'system',
          scope: 'remote',
          at: 1_700_000_000_500
        })
        expect(del.status).toBe('deleted')

        // Flush pending bodies -> must NOT write file for deleted session/run
        mirror.flushPendingBodies()
        expect(mirror.sink!.bodyStore.hasExternalBody(sha)).toBe(false)
      } finally {
        mirror.close()
      }
    })
  })
})

describe('P4-2 gap 3: off-main-thread legacy ledger parsing', () => {
  it('parses snapshot + jsonl in a worker thread matching synchronous output exactly', async () => {
    await withTempDirAsync(async (userData) => {
      const ledgerDir = join(userData, 'remote', 'ledger')
      mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
      const t0 = 1_700_000_000_000
      const snapRuns = []
      let seq = 0
      for (let i = 0; i < 200; i += 1) {
        const intentSeq = ++seq
        seq += 2
        snapRuns.push({
          runId: `snap-run-${i}`,
          lifecycle: 'settled',
          intentId: `snap-intent-${i}`,
          intentSeq,
          intentAt: t0 + i,
          intentDetail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: `snap ${i}` })
        })
      }
      writeFileSync(
        join(ledgerDir, 'session-ledger.snapshot.json'),
        JSON.stringify({ snapshot: { lastSeq: seq, runs: snapRuns } })
      )
      const tail: string[] = []
      for (let i = 0; i < 100; i += 1) {
        const runId = `tail-run-${i}`
        tail.push(
          JSON.stringify({
            seq: ++seq,
            at: t0 + 1000 + i,
            runId,
            kind: 'intent_recorded',
            intentId: `tail-intent-${i}`,
            detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws', prompt: `tail ${i}` })
          }),
          JSON.stringify({ seq: ++seq, at: t0 + 1000 + i + 1, runId, kind: 'run_dispatched' })
        )
        if (i < 99) {
          tail.push(JSON.stringify({ seq: ++seq, at: t0 + 1000 + i + 2, runId, kind: 'run_settled' }))
        }
      }
      writeFileSync(join(ledgerDir, 'session-ledger.log'), `${tail.join('\n')}\n`)

      const syncRead = readLegacyLedgerReadOnly(ledgerDir)
      const asyncRead = await readLegacyLedgerAsync(ledgerDir)
      expect(asyncRead.lastSeq).toBe(syncRead.lastSeq)
      expect(asyncRead.runs.size).toBe(syncRead.runs.size)
      for (const [key, value] of syncRead.runs) {
        expect(asyncRead.runs.get(key)).toEqual(value)
      }

      const sink = EventSink.open({ userDataDir: userData })
      try {
        const syncPlan = loadLegacyLedgerPlan(sink, userData)
        const asyncPlan = await loadLegacyLedgerPlanAsync(sink, userData)
        expect(asyncPlan.lastSeq).toBe(syncPlan.lastSeq)
        expect(asyncPlan.unimportedRuns).toEqual(syncPlan.unimportedRuns)
        expect(asyncPlan.openRuns).toEqual(syncPlan.openRuns)
        expect(asyncPlan.runsByLedgerId.size).toBe(syncPlan.runsByLedgerId.size)

        const deferred = startDeferredLegacyImport({
          sink,
          userDataDir: userData,
          plan: asyncPlan,
          maxSliceMs: 4
        })
        const summary = await deferred.promise
        expect(summary.importedRuns).toBe(300)
        expect(summary.legacyLedgerSeq).toBe(seq)
      } finally {
        sink.close()
      }
    })
  })
})
