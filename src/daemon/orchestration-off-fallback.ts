import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { recoverDeadRemoteLease } from '../main/remote/recover-dead-lease'
import { SessionLedger } from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { buildH1SnapshotFromDb, readReservedSeqUntil } from '../host-runtime/orchestration/legacy-snapshot-builder'
import { parseOrchestrationMode } from '../host-runtime/orchestration/mode'
import { recoverOrchestrationOnStartup } from '../host-runtime/orchestration/recovery'
import { createRecorderEvidenceFinder } from '../host-runtime/orchestration/recorder-evidence'

/**
 * Decision H §14.4 (`off` / unset / `shadow` default-path-safe reconciliation):
 * - Runs ONLY when `orch_meta.orchestration_on_active === '1'` (previous run was authoritative `on`).
 *   Shadow-only or never-`on` data dirs return immediately without touching H1 byte-for-byte.
 * - Strictly fail-open: if `orchestration.db` cannot be opened or is corrupt, logs and returns
 *   without touching H1 so daemon startup is never blocked.
 * - Uses `h1.describe().lastSeq` (NEVER `since(0).cursor` which caps at page size 256) to check
 *   whether H1 lags behind DB / reserved seq ceiling `R`.
 * - Rebuilt H1 snapshot always has `lastSeq >= R` (`h1_seq_reserved_until`).
 */
export function reconcileH1ForOffMode(options: {
  userDataDir: string
  remoteStateDirectory: string
  env: NodeJS.ProcessEnv
  log: (line: string) => void
}): void {
  if (parseOrchestrationMode(options.env).effective === 'on') return
  const dbPath = join(options.userDataDir, 'orchestration', 'orchestration.db')
  if (!existsSync(dbPath)) return

  let sink: EventSink | undefined
  try {
    sink = EventSink.open({
      userDataDir: options.userDataDir,
      checkpointIntervalMs: 0
    })

    // Default path safety (N1): NEVER touch H1 unless `on` mode was previously authoritative.
    if (sink.getMeta('orchestration_on_active') !== '1') return

    const fallbackUnavailable = sink.getMeta('h1_fallback_unavailable') === '1'

    const ledgerDirectory = join(options.remoteStateDirectory, 'ledger')
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 })
    chmodSync(ledgerDirectory, 0o700)
    recoverDeadRemoteLease(ledgerDirectory, 'session-ledger.lock')

    // Recover any open dispatched runs left by a crash in `on` mode before exporting to H1.
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
    // Default path safety (N2): strictly fail-open; never block off/unset/shadow startup or touch H1.
    const msg = error instanceof Error ? error.message : String(error)
    options.log(`daemon.orchestration-off-reconcile-failed ${msg}`)
  } finally {
    try {
      sink?.close()
    } catch {
      // Preserve fail-open semantics.
    }
  }
}
