import { open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationStore } from '../main/conversation-store'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
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

  const alreadyOnActive = sink.getMeta('orchestration_on_active') === '1'
  let h1DiskLastSeq = 0
  if (alreadyOnActive) {
    h1DiskLastSeq = await peekH1LastSeqAsync(userDataDir)
  } else {
    let plan: LegacyLedgerPlan | undefined
    try {
      plan = await loadLegacyLedgerPlanAsync(sink, userDataDir)
    } catch (error) {
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
      } else if (plan.unimportedRuns.length > 0 || plan.lastSeq > plan.currentLedgerSeq) {
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
    }
    sink.setMeta('orchestration_on_active', '1')
  }

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

  const recovery = recoverOrchestrationOnStartup({
    sink,
    leaseOwner,
    findRecorderEvidence: createRecorderEvidenceFinder(userDataDir, sink)
  })
  await reconcileTwoLedgersOnStartup({ sink, conversationStore: conversationStore() })

  return { recovery, deferredPlan, importComplete, resolveImportComplete, h1DiskLastSeq }
}
