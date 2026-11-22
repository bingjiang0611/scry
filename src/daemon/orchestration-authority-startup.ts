import { open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationStore } from '../main/conversation-store'
import { createConversationProjectionAccess } from './orchestration-conversation-projection'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { importCatalogEntries } from '../host-runtime/orchestration/legacy-catalog-and-repair'
import {
  importLegacyStateIncrementally,
  loadLegacyLedgerPlanAsync,
  type LegacyLedgerPlan
} from '../host-runtime/orchestration/legacy-import'
import {
  reconcileTwoLedgersOnStartup,
  recoverOrchestrationOnStartup,
  type RecoverOrchestrationSummary
} from '../host-runtime/orchestration/recovery'
import { createRecorderEvidenceFinder } from '../host-runtime/orchestration/recorder-evidence'

const SNAPSHOT_HEADER_BYTES = 512
const LOG_TAIL_SCAN_BYTES = 1_500_000

/**
 * Lightweight async peek of H1's on-disk `lastSeq` (W16 Part 1): reads only the 512 B snapshot
 * header (`"snapshot":{"version":1,"lastSeq":<N>`) and the tail of `session-ledger.log`, avoiding
 * a main-thread synchronous parse+stringify+SHA-256 of multi-megabyte snapshots (33k runs = 21 MB).
 * Strictly fail-open (corrupt/missing H1 returns 0).
 */
async function peekH1LastSeqAsync(userDataDir: string): Promise<number> {
  const ledgerDir = join(userDataDir, 'remote', 'ledger')
  let maxSeq = 0
  try {
    const fh = await openFile(join(ledgerDir, 'session-ledger.snapshot.json'), 'r')
    try {
      const buf = Buffer.allocUnsafe(SNAPSHOT_HEADER_BYTES)
      const { bytesRead } = await fh.read(buf, 0, SNAPSHOT_HEADER_BYTES, 0)
      const header = buf.toString('utf8', 0, bytesRead)
      const match = /"snapshot"\s*:\s*\{\s*"version"\s*:\s*1\s*,\s*"lastSeq"\s*:\s*(\d+)/.exec(header)
      if (match) {
        const parsed = Number(match[1])
        if (Number.isSafeInteger(parsed) && parsed > maxSeq) maxSeq = parsed
      }
    } finally {
      await fh.close()
    }
  } catch {
    // Missing or unreadable snapshot: ignore.
  }
  try {
    const fh = await openFile(join(ledgerDir, 'session-ledger.log'), 'r')
    try {
      const st = await fh.stat()
      if (st.size > 0) {
        const readLen = Math.min(st.size, LOG_TAIL_SCAN_BYTES)
        const start = st.size - readLen
        const buf = Buffer.allocUnsafe(readLen)
        const { bytesRead } = await fh.read(buf, 0, readLen, start)
        const lines = buf.toString('utf8', 0, bytesRead).split('\n')
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]?.trim()
          if (!line) continue
          try {
            const ev = JSON.parse(line) as { seq?: unknown }
            if (typeof ev.seq === 'number' && Number.isSafeInteger(ev.seq) && ev.seq > maxSeq) {
              maxSeq = ev.seq
              break
            }
          } catch {
            // Skip truncated trailing line if any and inspect prior complete line.
          }
        }
      }
    } finally {
      await fh.close()
    }
  } catch {
    // Missing or unreadable log: ignore.
  }
  return maxSeq
}

export interface AuthorityStartupResult {
  recovery: RecoverOrchestrationSummary
  deferredPlan: LegacyLedgerPlan | undefined
  importComplete: Promise<void>
  resolveImportComplete: (() => void) | undefined
  h1DiskLastSeq: number
}

/**
 * Runs P4-2 startup legacy import (only when transitioning from `off`/fresh DB, never reading a
 * degraded H1 downstream mirror once `on` mode is already active), installs Decision G observer,
 * and executes single-tx startup recovery + two-ledger reconciliation BEFORE `openLocalChannel`.
 */
export async function runAuthorityStartupSequence(options: {
  sink: EventSink
  userDataDir: string
  leaseOwner: string
  pendingTtlMs: number
  deferredThreshold: number
  conversationStore: () => ConversationStore
  resolveTurnOrdinal: (sessionKey: string, runId: string) => number | undefined
  log: (line: string) => void
}): Promise<AuthorityStartupResult> {
  const { sink, userDataDir, leaseOwner, pendingTtlMs, deferredThreshold, conversationStore, resolveTurnOrdinal, log } =
    options
  let deferredPlan: LegacyLedgerPlan | undefined
  let resolveImportComplete: (() => void) | undefined
  let importComplete: Promise<void> = Promise.resolve()

  // B1-B3 + W16 Part 1: once `on` mode is active, orchestration.db is the sole authority and H1 is a pure
  // downstream mirror; only peek H1's `lastSeq` asynchronously (without parsing 21 MB JSON on main thread)
  // when `alreadyOnActive` is true to guard against fail-open `off` residual. On `off -> on`,
  // `loadLegacyLedgerPlanAsync` already parsed H1 off-thread and updated `h1_seq_reserved_until`.
  const alreadyOnActive = sink.getMeta('orchestration_on_active') === '1'
  let h1DiskLastSeq = 0
  if (alreadyOnActive) {
    h1DiskLastSeq = await peekH1LastSeqAsync(userDataDir)
    // Existing authoritative databases may have started with a catalog and no H1 entries.
    if (!sink.getMeta('legacy_catalog_sha256')) importCatalogEntries(sink, userDataDir, Date.now())
  } else {
    let plan: LegacyLedgerPlan | undefined
    try {
      plan = await loadLegacyLedgerPlanAsync(sink, userDataDir)
    } catch (error) {
      // If DB already has authoritative events and H1 is corrupt, fall back to DB authority.
      const hasExistingEvents =
        (sink.handle.db.prepare('SELECT COUNT(*) AS c FROM orch_event').get() as { c: number }).c > 0
      if (!hasExistingEvents) throw error
      log(`daemon.orchestration-on-skip-corrupt-h1 ${error instanceof Error ? error.message : String(error)}`)
    }
    if (plan) {
      if (plan.lastSeq > 0) {
        const prevReserved = Number(sink.getMeta('h1_seq_reserved_until') ?? '0')
        if (plan.lastSeq > (Number.isFinite(prevReserved) ? prevReserved : 0)) {
          sink.setMeta('h1_seq_reserved_until', String(plan.lastSeq))
        }
      }
      if (plan.unimportedRuns.length > deferredThreshold) {
        const pendingConvRunIds = new Set<string>()
        try {
          const ownership = await conversationStore().loadOwnership()
          for (const conv of ownership.values()) {
            for (const turn of conv.turns) {
              if (turn.origin === 'dispatch' && turn.delivery.status === 'pending') {
                pendingConvRunIds.add(turn.runId)
              }
            }
          }
        } catch {
          // Corrupt ownership is surfaced by reconcileTwoLedgersOnStartup below.
        }
        importLegacyStateIncrementally({
          sink,
          userDataDir,
          pendingTtlMs,
          reconcileOpenRuns: true,
          shadowOnly: false,
          openOnly: true,
          ...(pendingConvRunIds.size > 0 ? { extraRunIds: pendingConvRunIds } : {}),
          plan,
          resolveTurnOrdinal
        })
        deferredPlan = plan
        importComplete = new Promise<void>((resolve) => {
          resolveImportComplete = resolve
        })
      } else {
        importLegacyStateIncrementally({
          sink,
          userDataDir,
          pendingTtlMs,
          reconcileOpenRuns: true,
          shadowOnly: false,
          plan,
          resolveTurnOrdinal
        })
      }
    } else {
      importCatalogEntries(sink, userDataDir, Date.now())
    }
    sink.setMeta('orchestration_on_active', '1')
  }

  // Decision G: install before-turn-settled observer BEFORE reconcileTwoLedgersOnStartup.
  conversationStore().setBeforeTurnSettledObserver((info) => {
    if (sink.isWriteIndeterminate()) return
    const at = Date.now()
    const delivery = info.delivery.status
    const payload = {
      sessionKey: info.conversationId,
      runId: info.runId,
      ordinal: info.ordinal,
      delivery,
      ...(info.delivery.status !== 'accepted' ? { reason: info.delivery.reason } : {}),
      settledAt: at,
      evidence: [`conversation:${info.conversationId}`]
    }
    sink.execute({
      type: 'turn.record_delivery',
      commandId: `effect:p4-conv-${info.conversationId}-${info.runId}:${delivery}`,
      actor: `effect:p4-conv-${info.conversationId}`,
      scope: 'system',
      at,
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
  })

  // core §2.4 + §2.6 + §2.8: recover orchestration.db & two-ledger boundary BEFORE openLocalChannel.
  const recovery = recoverOrchestrationOnStartup({
    sink,
    leaseOwner,
    findRecorderEvidence: createRecorderEvidenceFinder(userDataDir, sink)
  })
  const managed = conversationStore()
  await reconcileTwoLedgersOnStartup({ sink, conversationStore: managed })
  const conversations = await managed.loadOwnership()
  if (conversations.size) createConversationProjectionAccess(() => sink, log).importExisting(conversations.values())

  return { recovery, deferredPlan, importComplete, resolveImportComplete, h1DiskLastSeq }
}
