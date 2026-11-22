import type Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { recoverDeadRemoteLease } from '../main/remote/recover-dead-lease'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { buildH1SnapshotFromDb, readReservedSeqUntil } from '../host-runtime/orchestration/legacy-snapshot-builder'
import { parseOrchestrationMode } from '../host-runtime/orchestration/mode'
import { recoverOrchestrationOnStartup } from '../host-runtime/orchestration/recovery'
import { createRecorderEvidenceFinder } from '../host-runtime/orchestration/recorder-evidence'

const require = createRequire(import.meta.url)

function probeOrchestrationOnActiveReadOnly(dbPath: string): { active: boolean; error?: unknown } {
  const DatabaseCtor = require('better-sqlite3') as typeof import('better-sqlite3')
  let db: Database.Database | undefined
  try {
    db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true, timeout: 0 })
    const row = db
      .prepare("SELECT value FROM orch_meta WHERE key = 'orchestration_on_active'")
      .get() as { value?: string } | undefined
    return { active: row?.value === '1' }
  } catch (error) {
    return { active: false, error }
  } finally {
    try {
      db?.close()
    } catch {
    }
  }
}

export function reconcileH1ForOffMode(options: {
  userDataDir: string
  remoteStateDirectory: string
  env: NodeJS.ProcessEnv
  log: (line: string) => void
}): void {
  if (parseOrchestrationMode(options.env).effective === 'on') return
  const dbPath = join(options.userDataDir, 'orchestration', 'orchestration.db')
  if (!existsSync(dbPath)) return

  const probe = probeOrchestrationOnActiveReadOnly(dbPath)
  if (probe.error) {
    const msg = probe.error instanceof Error ? probe.error.message : String(probe.error)
    options.log(`daemon.orchestration-off-reconcile-failed ${msg}`)
    return
  }
  if (!probe.active) return

  let sink: EventSink | undefined
  try {
    sink = EventSink.open({
      userDataDir: options.userDataDir,
      checkpointIntervalMs: 0
    })

    if (sink.getMeta('orchestration_on_active') !== '1') return

    const fallbackUnavailable = sink.getMeta('h1_fallback_unavailable') === '1'

    const ledgerDirectory = join(options.remoteStateDirectory, 'ledger')
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
    chmodSync(ledgerDirectory, 0o700)
    recoverDeadRemoteLease(ledgerDirectory, 'session-ledger.lock')

    recoverOrchestrationOnStartup({
      sink,
      leaseOwner: `daemon-off-fallback:${process.pid}`,
      findRecorderEvidence: createRecorderEvidenceFinder(options.userDataDir, sink)
    })

    const reservedUntil = readReservedSeqUntil(sink)
    const legacySeq = Math.max(0, Math.floor(Number(sink.getMeta('legacy_ledger_seq') ?? '0') || 0))
    const dbSnapshot = buildH1SnapshotFromDb(sink, { lastSeq: Math.max(reservedUntil, legacySeq) })
    let needsRebuild = fallbackUnavailable

    const fileStore = new SessionLedgerFileStore(ledgerDirectory)
    try {
      if (!needsRebuild) {
        try {
          const h1 = new SessionLedger({ store: fileStore })
          const h1LastSeq = h1.describe().lastSeq
          const missingRun = dbSnapshot.runs.some((r) => h1.runState(r.runId) === undefined)
          if (h1LastSeq < dbSnapshot.lastSeq || missingRun) {
            needsRebuild = true
          }
        } catch {
          needsRebuild = true
        }
      }

      if (needsRebuild) {
        fileStore.compact(dbSnapshot)
        sink.setMeta('legacy_ledger_seq', String(dbSnapshot.lastSeq))
        sink.setMeta('h1_fallback_unavailable', '0')
        sink.setMeta('h1_fallback_reason', '')
        options.log(
          `daemon.orchestration-off-rebuilt-h1 runs=${dbSnapshot.runs.length} lastSeq=${dbSnapshot.lastSeq}`
        )
      }
      sink.setMeta('orchestration_on_active', '0')
    } finally {
      fileStore.close()
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    options.log(`daemon.orchestration-off-reconcile-failed ${msg}`)
  } finally {
    try {
      sink?.close()
    } catch {
    }
  }
}
