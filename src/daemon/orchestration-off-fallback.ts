import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { recoverDeadRemoteLease } from '../main/remote/recover-dead-lease'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { buildH1SnapshotFromDb } from '../host-runtime/orchestration/legacy-snapshot-builder'
import { parseOrchestrationMode } from '../host-runtime/orchestration/mode'
import { recoverOrchestrationOnStartup } from '../host-runtime/orchestration/recovery'
import { createRecorderEvidenceFinder } from '../host-runtime/orchestration/recorder-evidence'

/**
 * When switching back to `SCRY_ORCHESTRATION=off` after `on` mode ran (W9 Round-3 B1-B3 fix):
 * checks whether the downstream H1 ledger on disk is lagging or corrupt relative to `orchestration.db`.
 * If so, atomically regenerates H1 from `orchestration.db` (`tmp + fsync + rename + dir fsync`)
 * before `off` mode opens `SessionLedgerFileStore`.
 */
export function reconcileH1ForOffMode(options: {
  userDataDir: string
  remoteStateDirectory: string
  env: NodeJS.ProcessEnv
  log: (line: string) => void
}): void {
  if (parseOrchestrationMode(options.env).effective !== 'off') return
  const dbPath = join(options.userDataDir, 'orchestration', 'orchestration.db')
  if (!existsSync(dbPath)) return

  const sink = EventSink.open({
    userDataDir: options.userDataDir,
    checkpointIntervalMs: 0
  })
  try {
    const onActive = sink.getMeta('orchestration_on_active') === '1'
    const fallbackUnavailable = sink.getMeta('h1_fallback_unavailable') === '1'

    const ledgerDirectory = join(options.remoteStateDirectory, 'ledger')
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
    chmodSync(ledgerDirectory, 0o700)
    recoverDeadRemoteLease(ledgerDirectory, 'session-ledger.lock')

    // Recover any open dispatched runs left by a crash in `on` mode before exporting to H1.
    if (onActive) {
      recoverOrchestrationOnStartup({
        sink,
        leaseOwner: `daemon-off-fallback:${process.pid}`,
        findRecorderEvidence: createRecorderEvidenceFinder(options.userDataDir, sink)
      })
    }

    const dbSnapshot = buildH1SnapshotFromDb(sink)
    let needsRebuild = fallbackUnavailable

    const fileStore = new SessionLedgerFileStore(ledgerDirectory)
    try {
      if (!needsRebuild) {
        try {
          const h1 = new SessionLedger({ store: fileStore })
          const h1Cursor = h1.since(0).cursor
          const missingRun = dbSnapshot.runs.some((r) => h1.runState(r.runId) === undefined)
          if (h1Cursor < dbSnapshot.lastSeq || missingRun) {
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
      if (onActive) {
        sink.setMeta('orchestration_on_active', '0')
      }
    } finally {
      fileStore.close()
    }
  } finally {
    sink.close()
  }
}
