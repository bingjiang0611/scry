import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import type { RecorderEnablement } from './config.js'
import { hostProcessState } from './host-process.js'
import { readJson, writeJsonAtomic } from './io.js'
import { clearRuntimeTurn } from './store.js'
import { finalizeOpenTurn } from './recorder-turn-finalize.js'
import {
  openTurnQuiet, recorderOpenPath, recorderQuarantineIndexPath, recorderQuarantinedOpenTurns, recorderStatePath,
  recorderTurnRoot, withRecorderSessionLock, type RecorderOpenTurnState, type RecorderSessionState
} from './runtime-state.js'

export const MANAGED_TURN_ORPHAN_MS = 30 * 60 * 1_000
export const MANAGED_QUARANTINE_EXPIRY_MS = 24 * 60 * 60 * 1_000

export const MANAGED_ORPHAN_REASON =
  'no supervisor managed this turn any more, so the recorder sealed it with only the evidence it could still observe'

export interface ManagedOrphanVerdict {
  status: AgentTurnRecord['status']
  at: string
  reason: string
}

async function lastActivityAt(root: string, open: RecorderOpenTurnState, now: number): Promise<number> {
  const quiet = await openTurnQuiet(root, open, now)
  if (Number.isFinite(quiet.quietMs)) return now - quiet.quietMs
  const touched = await stat(recorderOpenPath(root)).then((info) => info.mtimeMs).catch(() => Number.NaN)
  return Number.isFinite(touched) ? touched : now
}

export async function managedOrphanVerdict(args: {
  root: string
  open: RecorderOpenTurnState
  now?: number
  thresholdMs?: number
}): Promise<ManagedOrphanVerdict | undefined> {
  const { open } = args
  if (!open.managedByScry) return undefined
  const now = args.now ?? Date.now()
  const threshold = args.thresholdMs ?? MANAGED_TURN_ORPHAN_MS
  const quietFor = now - await lastActivityAt(args.root, open, now)
  if (!Number.isFinite(quietFor) || quietFor < threshold) return undefined
  if (await hostProcessState(open.host) === 'running') return undefined
  const waiting = open.status === 'closing'
  return {
    status: waiting ? open.terminalFallbackStatus ?? 'completed' : 'interrupted',
    at: new Date(now).toISOString(),
    reason: `${MANAGED_ORPHAN_REASON}: the turn was ${waiting ? 'waiting for its supervisor to seal it' : 'still open'}, nothing wrote to it for ${Math.round(quietFor / 60_000)} minutes, and no process recorded as hosting it is still running`
  }
}

export function orphanClosingState(
  open: RecorderOpenTurnState,
  verdict: Pick<ManagedOrphanVerdict, 'status' | 'at'>
): RecorderOpenTurnState {
  return {
    ...open,
    status: 'closing',
    closingAt: verdict.at,
    endReason: 'expired',
    terminalFallbackStatus: verdict.status
  }
}

export interface QuarantineSealResult {
  sealed: number
  pending: number
  pruned: number
}

export async function sealExpiredQuarantinedTurns(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  sessionDir: string,
  options: { now?: number; thresholdMs?: number } = {}
): Promise<QuarantineSealResult> {
  const now = options.now ?? Date.now()
  const threshold = options.thresholdMs ?? MANAGED_QUARANTINE_EXPIRY_MS
  const indexed = await readJson<string[]>(recorderQuarantineIndexPath(sessionDir))
  if (!Array.isArray(indexed) || indexed.length === 0) return { sealed: 0, pending: 0, pruned: 0 }
  let sealed = 0
  let pending = 0
  let pruned = 0
  for (const item of await recorderQuarantinedOpenTurns(sessionDir)) {
    if ((item as { reason?: string }).reason !== 'managed_replaced') continue
    if (item.sealedAt) {
      const sealedFor = now - Date.parse(item.sealedAt)
      if (Number.isFinite(sealedFor) && sealedFor >= threshold) {
        await clearRuntimeTurn(enablement.dataRoot, recorderTurnRoot(sessionDir, item.generation))
        pruned++
      }
      continue
    }
    const quarantinedAt = Date.parse((item as { quarantinedAt?: string }).quarantinedAt ?? '')
    const since = Number.isFinite(quarantinedAt)
      ? quarantinedAt
      : await stat(join(recorderTurnRoot(sessionDir, item.generation), 'pending-open.json'))
        .then((info) => info.mtimeMs).catch(() => now)
    if (now - since < threshold) continue
    if (await readJson(recorderOpenPath(sessionDir))) {
      pending++
      continue
    }
    const at = new Date(now).toISOString()
    const reason = `${MANAGED_ORPHAN_REASON}: this turn was replaced by a managed successor ${Math.round((now - since) / 3_600_000)} hours ago and nothing can still seal it`
    const result = await withRecorderSessionLock(enablement.dataRoot, item.provider, item.sessionId, async () => {
      if (await readJson(recorderOpenPath(sessionDir))) return 'pending' as const
      const stateBefore = await readJson<RecorderSessionState>(recorderStatePath(sessionDir))
      const closing = orphanClosingState(item, { status: 'interrupted', at })
      const finalized = await finalizeOpenTurn(enablement, closing, { timestamp: at }, 'interrupted', {
        allowUnstableTranscript: true,
        forcedReason: reason,
        retainTurnRoot: true
      })
      if (finalized.status !== 'committed' && finalized.status !== 'duplicate') return 'pending' as const
      await writeJsonAtomic(join(recorderTurnRoot(sessionDir, item.generation), 'pending-open.json'), {
        ...item,
        sealedAt: at,
        sealedRecordId: finalized.record?.recordId
      })
      if (stateBefore?.lastCommittedRecordId && stateBefore.lastCommittedRecordId !== finalized.record?.recordId) {
        await writeJsonAtomic(recorderStatePath(sessionDir), {
          ...stateBefore,
          committedProviderTurnIds: [...new Set([
            ...(stateBefore.committedProviderTurnIds ?? []),
            ...(item.providerTurnId ? [item.providerTurnId] : [])
          ])].slice(-200)
        }, { sync: false })
      }
      return 'sealed' as const
    })
    if (result === 'sealed') sealed++
    else pending++
  }
  if (sealed > 0 || pruned > 0) await recorderQuarantinedOpenTurns(sessionDir, { reconcile: true })
  return { sealed, pending, pruned }
}
