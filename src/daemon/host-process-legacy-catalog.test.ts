import 'reflect-metadata'
import { appendFileSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { importCatalogEntries } from '../host-runtime/orchestration/legacy-catalog-and-repair'
import { createAppSessionStore } from '../main/app-store'
import { readHistoryCatalogEntry } from '../main/bootstrap/history-catalog'
import { ConversationStore } from '../main/conversation-store'
import { RunRegistry } from '../main/run-registry'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { attachDaemonOrchestrationAuthority } from './orchestration-authority'
import { createOrchestrationCatalogAccess } from './orchestration-catalog-access'

import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

it('R10: the daemon replays pending metadata after deferred import', async () => {
  const root = tempDir()
  const userDataDir = join(root, 'userData')
  mkdirSync(join(root, 'workspace'))
  const cwd = realpathSync(join(root, 'workspace'))
  const sessionId = 'late-native'
  const ledger = join(userDataDir, 'remote', 'ledger')
  mkdirSync(ledger, { recursive: true })
  const at = Date.now() - 60_000
  const lines = Array.from({ length: 2001 }, (_, i) => {
    const runId = randomUUID()
    const seq = i * 3 + 1
    return [
      { seq, at, kind: 'intent_recorded', runId, intentId: randomUUID(),
        detail: JSON.stringify({ providerId: 'codex', cwd, resume: i === 2000 ? sessionId : undefined }) },
      { seq: seq + 1, at, kind: 'run_dispatched', runId },
      { seq: seq + 2, at, kind: 'run_settled', runId }
    ]
  }).flat()
  writeFileSync(join(ledger, 'session-ledger.log'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  writeFileSync(join(userDataDir, 'session-metadata-pending.json'), JSON.stringify([{
    externalSessionId: sessionId, providerId: 'codex', cwd, actor: 'user:local', change: { kind: 'rename', title: 'Replayed title' }
  }]))
  let resume!: () => void
  const pause = new Promise<void>(resolve => { resume = resolve })
  const daemon = await startTestDaemon({ root, orchestrationPauseBackfill: pause })
  try {
    const authority = daemon.host.orchestrationAuthority!
    expect(authority.sink.getSession(sessionId)).toBeUndefined()
    resume()
    await authority.importComplete
    await vi.waitFor(() => {
      expect(authority.sink.getSession(sessionId)?.title).toBe('Replayed title')
    })
  } finally {
    resume()
    await daemon.dispose()
  }
}, 20_000)

function seedHistory() {
  const userDataDir = tempDir()
  const cwd = realpathSync(tempDir())
  const ledgerDir = join(userDataDir, 'remote', 'ledger')
  const store = createAppSessionStore(userDataDir)
  const providerId = 'codex' as const
  const resumable = ['saved-session', 'other-session'].map((externalSessionId) => ({
    providerId, cwd, externalSessionId
  }))
  const runIds = Array.from({ length: 2_001 }, () => randomUUID())
  for (const [index, ref] of resumable.entries()) {
    store.record({ ...ref, runtimeProvider: 'codex_cli', runId: runIds[index], prompt: `history ${index}` })
  }
  const at = Date.now() - 60_000
  const lines = runIds.flatMap((runId, index) => {
    const seq = index * 3 + 1
    const detail = JSON.stringify({ providerId, cwd, resume: resumable[index]?.externalSessionId })
    return [
      { seq, at, kind: 'intent_recorded', runId, intentId: randomUUID(), detail },
      { seq: seq + 1, at, kind: 'run_dispatched', runId },
      { seq: seq + 2, at, kind: 'run_settled', runId }
    ]
  })
  mkdirSync(ledgerDir, { recursive: true })
  const log = join(ledgerDir, 'session-ledger.log')
  writeFileSync(log, lines.map((event) => JSON.stringify(event)).join('\n') + '\n')
  return { userDataDir, resumable, runIds, log }
}

async function startDuringBackfill(userDataDir: string) {
  let resume!: () => void
  const pause = new Promise<void>((resolve) => { resume = resolve })
  const conversationStore = new ConversationStore(userDataDir)
  const authority = await attachDaemonOrchestrationAuthority({
    userDataDir, env: {}, conversationStore: () => conversationStore,
    runs: new RunRegistry(), requestRunStop: () => false, log: () => undefined,
    pauseDeferredImport: pause
  })
  authority.startImport()
  const catalog = createOrchestrationCatalogAccess(() => authority.sink)
  return { authority, catalog, resume }
}

it('serves the full local catalog and history identity while terminal backfill is paused', async () => {
  const { userDataDir, resumable, runIds } = seedHistory()
  const seededCatalog = createAppSessionStore(userDataDir).load()
  const extra = runIds.slice(resumable.length).map((runId, index) => ({
    ...resumable[0], sessionId: `legacy-${index}`, externalSessionId: `legacy-${index}`, runId,
    ts: Date.now() - index, preview: 'older history'
  }))
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([...seededCatalog, ...extra]))
  const { authority, catalog, resume } = await startDuringBackfill(userDataDir)
  try {
    expect(authority.sink.getRun(runIds[0])).toBeUndefined()
    expect(authority.sink.getRun(runIds.at(-1)!)).toBeUndefined()
    expect(catalog.read()?.map((row) => row.externalSessionId).sort())
      .toEqual([...resumable, ...extra].map((row) => row.externalSessionId).sort())
    expect(readHistoryCatalogEntry(resumable[0], (path) => path, () => [], catalog.readDetail))
      .toMatchObject({ session: { externalSessionId: resumable[0].externalSessionId }, projection: { legacyBefore: true } })
  } finally {
    await authority.close()
    resume()
  }
})

it('preserves a deletion made while backfill is paused without discarding neighboring runs', async () => {
  const { userDataDir, resumable, runIds } = seedHistory()
  const seed = EventSink.open({ userDataDir, fullfsync: false })
  try {
    expect(importCatalogEntries(seed, userDataDir, Date.now()).importedSessions).toBe(2)
  } finally {
    seed.close()
  }
  const { authority, catalog, resume } = await startDuringBackfill(userDataDir)
  try {
    expect(authority.sink.getRun(runIds[0])).toBeUndefined()
    expect(catalog.deleteNative(resumable[0], new Set())).toMatchObject({ status: 'deleted' })
    expect(catalog.readDetail(resumable[0], resumable[0].cwd)).toBeNull()
    resume()
    await authority.importComplete
    expect(authority.sink.getSession(resumable[0].externalSessionId)).toBeUndefined()
    expect(authority.sink.getRun(runIds[0])).toBeUndefined()
    expect(authority.sink.getRun(runIds[1])?.lifecycle).toBe('settled')
    expect(authority.sink.getRun(runIds.at(-1)!)?.lifecycle).toBe('settled')
    expect(catalog.read()?.map((row) => row.externalSessionId)).toEqual([resumable[1].externalSessionId])
    expect(catalog.readDetail(resumable[0], resumable[0].cwd)).toBeNull()
  } finally {
    await authority.close()
    resume()
  }
}, 15_000)

it('scopes colliding native history by workspace and honors a tombstone across cwd aliases', async () => {
  const { userDataDir, resumable, runIds, log } = seedHistory()
  const otherCwd = realpathSync(tempDir())
  const alias = join(tempDir(), 'native-workspace-alias')
  symlinkSync(resumable[1].cwd, alias, 'dir')
  const movedAlias = join(tempDir(), 'moved-workspace-alias')
  symlinkSync(otherCwd, movedAlias, 'dir')
  const [foreignRun, deletedRun, movedRun] = [randomUUID(), randomUUID(), randomUUID()]
  const at = Date.now() - 50_000
  let seq = runIds.length * 3
  for (const [runId, cwd, resume] of [
    [foreignRun, otherCwd, resumable[0].externalSessionId],
    [deletedRun, alias, resumable[1].externalSessionId],
    [movedRun, movedAlias, resumable[0].externalSessionId]
  ]) {
    const detail = JSON.stringify({ providerId: 'codex', cwd, resume })
    const events = [
      { seq: ++seq, at, kind: 'intent_recorded', runId, intentId: randomUUID(), detail },
      { seq: ++seq, at, kind: 'run_dispatched', runId },
      { seq: ++seq, at, kind: 'run_settled', runId }
    ]
    appendFileSync(log, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  }
  unlinkSync(movedAlias)
  symlinkSync(resumable[0].cwd, movedAlias, 'dir')
  const { authority, catalog, resume } = await startDuringBackfill(userDataDir)
  try {
    expect(catalog.deleteNative(resumable[1], new Set())).toMatchObject({ status: 'deleted' })
    resume()
    await authority.importComplete
    const visibleTurns = authority.sink.handle.db.prepare(
      'SELECT run_id FROM orch_p_turn WHERE session_key = ? ORDER BY ordinal'
    ).all(resumable[0].externalSessionId)
    expect.soft(visibleTurns).toEqual([{ run_id: runIds[0] }])
    const foreign = authority.sink.getRun(foreignRun)
    expect.soft(foreign).toMatchObject({ cwd: otherCwd, sessionKey: expect.stringMatching(/^native:/) })
    expect.soft(authority.sink.getSession(foreign?.sessionKey ?? '')).toMatchObject({ cwd: otherCwd })
    expect.soft(authority.sink.getRun(deletedRun)).toBeUndefined()
    expect.soft(authority.sink.getRun(movedRun)).toMatchObject({ cwd: movedAlias, sessionKey: expect.stringMatching(/^native:/) })
    expect(catalog.readDetail(resumable[1], resumable[1].cwd)).toBeNull()
  } finally {
    await authority.close()
    resume()
  }
}, 15_000)
