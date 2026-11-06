import { access, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import type { TurnDiffSnapshot } from '../../shared/trace.js'
import type { GitTurnDiffCapture } from './git.js'
import type { RepositoryDiscovery } from './config.js'
import { listFiles, readJson, withDirectoryLock } from './io.js'
import {
  ATTENTION_PROVIDERS, attentionIndexPresent, clearSessionAttention, markSessionAttention,
  markedSessions, type MarkedSession
} from './attention.js'
import { safeKey } from './store.js'
import { recorderHasRetryableInbox, recorderInboxEntries } from './inbox.js'

export interface RecorderSessionState {
  schemaVersion: 1
  lastGeneration: number
  lastTurnIndex: number
  lastCommittedRecordId?: string
  committedProviderTurnIds?: string[]
}

export interface RecorderOpenTurnState {
  uploadEnvironment?: import('./commit-environment.js').UploadEnvironment
  toolContentPolicy?: import('./tool-content.js').ToolContentPolicy
  schemaVersion: 1
  provider: ProviderId
  sessionId: string
  generation: number
  turnIndex: number
  status: 'open' | 'closing'
  startedAt: string
  /** When closing began. Bookkeeping for pending health only — never an end time. */
  closingAt?: string
  /** Credible end of Agent work, set only by a real terminal observation. */
  terminalAt?: string
  terminalAtSource?: 'provider_terminal_event' | 'recorder_observed_terminal'
  /** Verdict pinned when closing was deferred, so background finalize cannot upgrade it. */
  terminalFallbackStatus?: AgentTurnRecord['status']
  endReason?: import('../../shared/turn-record.js').TurnEndReason
  prompt?: string
  promptHash?: string
  managedRunId?: string
  managedPromptHash?: string
  startFingerprint: string
  transcriptPath?: string
  transcriptStartOffset?: number
  providerTurnId?: string
  /** Qoder hook identity; it must be mapped to a native promptId before use. */
  requestSetId?: string
  terminalDiffs?: Array<{ repository: string; snapshot: TurnDiffSnapshot }>
  continuationProviderTurnIds?: string[]
  managedByScry?: boolean
  staleTerminalProtection?: boolean
  deferredTerminalAt?: string
  deferredTerminalEventId?: string
  /** SessionEnd proved that a deferred unidentified terminal belongs to the final open turn. */
  terminalIdentityConfirmedBySessionEnd?: boolean
  repositoryDiscovery?: Pick<RepositoryDiscovery, 'maxDepth' | 'depthLimitedDirectories'>
  captures: Array<{ repository: string; capture: GitTurnDiffCapture }>
}

export const SESSION_LOCK_WAIT_MS = 10_000
// A lifecycle hook queues its event once this wait expires, so it must stay well under the
// Provider's hook timeout (10s for tool hooks); otherwise the host kills the hook before it queues.
export const HOOK_LOCK_WAIT_MS = 3_000

export function recorderSessionRoot(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(dataRoot, 'runtime', provider, safeKey(sessionId))
}

export function recorderTurnRoot(root: string, generation: number): string {
  return join(root, 'turns', String(generation).padStart(8, '0'))
}

export function recorderOpenPath(root: string): string {
  return join(root, 'open.json')
}

export function recorderStatePath(root: string): string {
  return join(root, 'session.json')
}

export function recorderSessionLock(dataRoot: string, provider: ProviderId, sessionId: string): string {
  return join(dataRoot, 'locks', 'sessions', provider, `${safeKey(sessionId)}.lock`)
}

export function withRecorderSessionLock<T>(
  dataRoot: string, provider: ProviderId, sessionId: string,
  action: () => Promise<T>, options: { waitMs?: number; ttlMs?: number } = {}
): Promise<T> {
  return withRecorderSessionKeyLock(dataRoot, provider, safeKey(sessionId), action, options)
}

/** Recovery can lock a corrupt inbox without trusting its first payload for a session id. */
export function withRecorderSessionKeyLock<T>(
  dataRoot: string, provider: ProviderId, sessionKey: string,
  action: () => Promise<T>, options: { waitMs?: number; ttlMs?: number } = {}
): Promise<T> {
  return withDirectoryLock(join(dataRoot, 'locks', 'sessions', provider, `${sessionKey}.lock`), async () => {
    // Admission only: GC either observes our session lock, or finishes before we publish.
    // Release the maintenance gate before work so independent sessions remain concurrent.
    await withDirectoryLock(join(dataRoot, 'locks', 'maintenance.lock'), async () => {}, options)
    return action()
  }, options)
}

export async function recorderQuarantinedOpenTurns(
  root: string
): Promise<RecorderOpenTurnState[]> {
  const turns = join(root, 'turns')
  const result: RecorderOpenTurnState[] = []
  for (const generation of await listFiles(turns)) {
    const open = await readJson<RecorderOpenTurnState>(
      join(turns, generation, 'pending-open.json')
    )
    if (open) result.push(open)
  }
  return result
}

/**
 * Rebuild the attention index from the authoritative session directories: `open.json`, a queued
 * hook, or a quarantined turn. Also drops markers whose session directory is gone.
 */
export async function reconcileAttentionIndex(dataRoot: string): Promise<MarkedSession[]> {
  const reconciled: MarkedSession[] = []
  const live = new Set<string>()
  for (const provider of ATTENTION_PROVIDERS) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    for (const sessionKey of await listFiles(providerRoot)) {
      const sessionDir = join(providerRoot, sessionKey)
      live.add(`${provider}__${sessionKey}`)
      if (!await sessionHasPendingEvidence(sessionDir)) {
        await clearSessionAttention(dataRoot, provider, sessionKey)
        continue
      }
      await markSessionAttention(dataRoot, provider, sessionKey)
      reconciled.push({ provider, sessionKey, sessionDir })
    }
  }
  for (const marker of await markedSessions(dataRoot)) {
    if (!live.has(`${marker.provider}__${marker.sessionKey}`)) {
      await clearSessionAttention(dataRoot, marker.provider, marker.sessionKey)
    }
  }
  return reconciled
}

/**
 * Drop the index entry for a session a recovery pass just visited and left nothing to do: no open
 * turn, no queued hook, no quarantined turn. Without this a stale marker would keep asking for
 * passes forever.
 */
export async function releaseStaleAttention(
  dataRoot: string,
  provider: ProviderId,
  sessionDir: string
): Promise<void> {
  if (await sessionHasPendingEvidence(sessionDir)) return
  await clearSessionAttention(dataRoot, provider, basename(sessionDir))
}

/**
 * Whether the session still holds evidence only a recovery pass can resolve. Keeps the index entry
 * alive even when nothing is retryable: `pendingHealth` still has to report that evidence.
 */
async function sessionHasPendingEvidence(sessionDir: string): Promise<boolean> {
  // Presence, not content: a corrupt open.json still needs a recovery pass to say so.
  if (await pathExists(recorderOpenPath(sessionDir))) return true
  if ((await recorderInboxEntries(sessionDir)).length > 0) return true
  return (await recorderQuarantinedOpenTurns(sessionDir)).length > 0
}

/** Whether a pass could make progress: the failed/unreadable remainder waits for manual repair. */
async function sessionNeedsPass(sessionDir: string): Promise<boolean> {
  if (await pathExists(recorderOpenPath(sessionDir))) return true
  if (await recorderHasRetryableInbox(sessionDir)) return true
  return (await recorderQuarantinedOpenTurns(sessionDir)).length > 0
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    // Anything other than absence is treated as present: recovery decides what it means.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

async function attentionSessions(dataRoot: string): Promise<MarkedSession[]> {
  // No index means unknown, not an empty workspace. Diagnostic readers must rebuild it too:
  // doctor/status may run before the daemon has visited a legacy or restored workspace.
  return await attentionIndexPresent(dataRoot)
    ? await markedSessions(dataRoot)
    : await reconcileAttentionIndex(dataRoot)
}

export async function recorderPendingHealth(
  dataRoot: string
): Promise<{ pendingCount: number; oldestPendingAgeMs: number }> {
  let pendingCount = 0
  let oldestPendingAgeMs = 0
  const now = Date.now()
  for (const { sessionDir: root } of await attentionSessions(dataRoot)) {
      for (const entry of await recorderInboxEntries(root)) {
        pendingCount++
        // queueHook encodes the arrival clock in the name; file mtime would reset on repair.
        const arrival = /^(\d{15})-/.exec(entry.name)
        if (arrival) oldestPendingAgeMs = Math.max(oldestPendingAgeMs, Math.max(0, now - Number(arrival[1])))
      }
      const open = await readJson<RecorderOpenTurnState>(
        recorderOpenPath(root)
      )
      const pending = [
        ...(open && (open.managedByScry || open.status === 'closing') ? [open] : []),
        ...(await recorderQuarantinedOpenTurns(root))
      ]
      for (const item of pending) {
        pendingCount++
        const started = Date.parse(item.closingAt ?? item.startedAt)
        if (Number.isFinite(started)) {
          oldestPendingAgeMs = Math.max(oldestPendingAgeMs, Math.max(0, now - started))
        }
      }
    }
  return { pendingCount, oldestPendingAgeMs }
}

/**
 * Open turns that can no longer converge: nothing terminal arrived and the transcript stopped
 * growing. A long-running turn keeps appending to its transcript, so the file's mtime — not the
 * turn's age alone — is what separates "still working" from "the Provider died".
 */
export async function recorderStaleOpenTurns(
  dataRoot: string,
  expiryMs: number,
  now = Date.now()
): Promise<Array<{ provider: ProviderId; sessionId: string; startedAt: string; ageMs: number }>> {
  const result: Array<{ provider: ProviderId; sessionId: string; startedAt: string; ageMs: number }> = []
  for (const { provider, sessionDir } of await attentionSessions(dataRoot)) {
    const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(sessionDir))
    if (!open || open.status !== 'open' || open.managedByScry) continue
    const startedAt = Date.parse(open.startedAt)
    if (!Number.isFinite(startedAt) || now - startedAt <= expiryMs) continue
    if (open.transcriptPath) {
      const touchedAt = await transcriptTouchedAt(open.transcriptPath)
      // Unreadable transcript counts as no activity: the turn cannot converge from it either.
      if (touchedAt != null && now - touchedAt <= expiryMs) continue
    }
    result.push({ provider, sessionId: open.sessionId, startedAt: open.startedAt, ageMs: now - startedAt })
  }
  return result
}

async function transcriptTouchedAt(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

/**
 * Whether a recovery pass should run. An absent index cannot answer the question, so it asks for a
 * pass: that pass rebuilds the index from the session directories.
 */
export async function recorderHasOpenTurn(dataRoot: string): Promise<boolean> {
  const sessions = await attentionSessions(dataRoot)
  for (const session of sessions) {
    if (await sessionNeedsPass(session.sessionDir)) return true
  }
  return false
}
