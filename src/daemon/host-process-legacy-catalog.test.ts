import 'reflect-metadata'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { importCatalogEntries } from '../host-runtime/orchestration/legacy-catalog-and-repair'
import { createAppSessionStore } from '../main/app-store'
import { readHistoryCatalogEntry } from '../main/bootstrap/history-catalog'
import { ConversationStore } from '../main/conversation-store'
import { RunRegistry } from '../main/run-registry'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { attachDaemonOrchestrationAuthority } from './orchestration-authority'
import { createOrchestrationCatalogAccess } from './orchestration-catalog-access'

afterEach(cleanupTempDirs)

function seedHistory() {
  const userDataDir = tempDir()
  const cwd = tempDir()
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
  writeFileSync(join(ledgerDir, 'session-ledger.log'), lines.map((event) => JSON.stringify(event)).join('\n') + '\n')
  return { userDataDir, resumable, runIds }
}

async function startDuringBackfill(userDataDir: string) {
  const pause = Promise.withResolvers<void>()
  const conversationStore = new ConversationStore(userDataDir)
  const authority = await attachDaemonOrchestrationAuthority({
    userDataDir, env: {}, conversationStore: () => conversationStore,
    runs: new RunRegistry(), requestRunStop: () => false, log: () => undefined,
    pauseDeferredImport: pause.promise
  })
  authority.startImport()
  const catalog = createOrchestrationCatalogAccess(() => authority.sink)
  return { authority, catalog, resume: pause.resolve }
}

it('serves the full local catalog and history identity while terminal backfill is paused', async () => {
  const { userDataDir, resumable, runIds } = seedHistory()
  const { authority, catalog, resume } = await startDuringBackfill(userDataDir)
  try {
    expect(authority.sink.getRun(runIds[0])).toBeUndefined()
    expect(authority.sink.getRun(runIds.at(-1)!)).toBeUndefined()
    expect(catalog.read()?.map((row) => row.externalSessionId).sort())
      .toEqual(resumable.map((row) => row.externalSessionId).sort())
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
