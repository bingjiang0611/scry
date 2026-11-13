import { access, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import type { TurnDiffSnapshot } from '../../shared/trace.js'
import type { GitTurnDiffCapture } from './git.js'
import type { RepositoryDiscovery } from './config.js'
import { listFiles, readJson, withDirectoryLock } from './io.js'
import {
  ATTENTION_PROVIDERS, attentionIndexPresent, clearSessionAttention, markSessionAttention,
  markedSessions, publishAttentionIndexReady, withSessionAttentionLock, type MarkedSession
} from './attention.js'
import { safeKey } from './store.js'
import { recorderHasRetryableInbox, recorderInboxEntries } from './inbox.js'

/**
 * The last segment this session sealed. A background wake that arrives after the seal opens a
 * continuation segment from here: it slices content past what the sealed turn already published and
 * links back to the turn that asked the user's original question.
 */
export interface RecorderSealedSegment {
  recordId: string
  /** The turn that owns the user's question; every continuation of it points here. */
  rootRecordId: string
  at: string
  providerTurnId?: string
  transcriptPath?: string
  /**
   * Transcript items the sealed record already published. Absent when the seal could not measure
   * its own boundary, which is the one case a continuation cannot slice at.
   */
  publishedEvents?: number
  /**
   * Each repository's end state at this seal: the tree the record published plus the store holding
   * its blobs. The next segment diffs against it, so its record shows only its own work.
   */
  frozenDiffs?: RecorderFrozenDiff[]
}

/**
 * A sealed segment's per-repository end state. Blobs live in the recorder's isolated object store,
 * never in the user's repository; `tempDir` owns them until the next segment publishes.
 */
export interface RecorderFrozenDiff {
  requestedRoot: string
  repoRoot?: string
  scope?: string
  tree: string
  at: string
  objectDir: string
  tempDir: string
  alternateObjectDirs?: string
}

export interface RecorderSessionState {
  schemaVersion: 1
  lastGeneration: number
  lastTurnIndex: number
  lastCommittedRecordId?: string
  committedProviderTurnIds?: string[]
  /** Repositories discovered from files this session touched; later turns baseline them too. */
  captureRepositories?: string[]
  lastSegment?: RecorderSealedSegment
}

/** What a continuation segment inherits from the sealed segment it continues. */
export interface RecorderContinuation {
  rootRecordId: string
  sealedRecordId: string
  /** Items the sealed segment already published; content before this point belongs to it. */
  publishedEvents?: number
  /** The continued turn's native identity, used to read the transcript this segment sits in. */
  providerTurnId?: string
  /** The wake's own request set, which is this segment's identity. */
  requestSetId?: string
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
  piTranscriptAnchor?: import('./recorder-contracts.js').PiTranscriptAnchor
  providerTurnId?: string
  /** Qoder hook identity; it must be mapped to a native promptId before use. */
  requestSetId?: string
  terminalDiffs?: Array<{ repository: string; snapshot: TurnDiffSnapshot }>
  continuationProviderTurnIds?: string[]
  managedByScry?: boolean
  staleTerminalProtection?: boolean
  deferredTerminalAt?: string
  deferredTerminalEventId?: string
  /** Why this Stop is held rather than published, so recovery and health can name it. */
  deferredTerminalReason?: 'stale_terminal' | 'pending_background_tasks'
  /** Present when a background notification opened this segment instead of a user prompt. */
  continuation?: RecorderContinuation
  /** End states frozen at this segment's Stop, before the quiet window decided to publish it. */
  frozenDiffs?: RecorderFrozenDiff[]
  /** SessionEnd proved that a deferred unidentified terminal belongs to the final open turn. */
  terminalIdentityConfirmedBySessionEnd?: boolean
  /**
   * When the Provider session ended while this turn was still open. A session end closes the turn on
   * the evidence it has even when an earlier terminal already claimed `endReason`; it never rewrites
   * that earlier verdict.
   */
  sessionEndedAt?: string
  repositoryDiscovery?: Pick<RepositoryDiscovery, 'maxDepth' | 'depthLimitedDirectories' | 'worktreeDiscovery'>
  captures: Array<{ repository: string; capture: GitTurnDiffCapture }>
  /**
   * Present only for a turn recorded under an explicit session capture. `baselineAt` says the Git
   * baseline was taken mid-turn (at the claim), so earlier work in the same turn is not in the diff.
   */
  capture?: {
    protocol: string
    captureId: string
    source: string
    task: string | null
    openedAt: string
    baselineAt?: string
  }
  /** Stop intent for a captured session; the turn still finishes from its own terminal events. */
  captureStopRequestedAt?: string
  /** Transcript bytes at stop time, so a later prompt can never be read back into this turn. */
  captureTranscriptEndOffset?: number
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
  const indexed = new Set((await markedSessions(dataRoot)).map(marker => `${marker.provider}__${marker.sessionKey}`))
  const live = new Set<string>()
  for (const provider of ATTENTION_PROVIDERS) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    // Missing providers are empty; an interrupted/unreadable scan must not publish readiness.
    const sessionKeys = await readdir(providerRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const sessionKey of sessionKeys) {
      const sessionDir = join(providerRoot, sessionKey)
      live.add(`${provider}__${sessionKey}`)
      // Nothing is removed on this path. A publisher arriving after the snapshot keeps its marker.
      // Only existing markers or legacy pending evidence need a locked, authoritative recheck.
      if (!indexed.has(`${provider}__${sessionKey}`) && !await sessionHasPendingEvidence(sessionDir)) continue
      await withSessionAttentionLock(dataRoot, provider, sessionKey, async () => {
        if (await sessionHasPendingEvidence(sessionDir)) {
          await markSessionAttention(dataRoot, provider, sessionKey)
        } else {
          await clearSessionAttention(dataRoot, provider, sessionKey)
        }
      })
    }
  }
  for (const marker of await markedSessions(dataRoot)) {
    if (!live.has(`${marker.provider}__${marker.sessionKey}`)) {
      // A publisher may have created the session after the directory snapshot; recheck under lock.
      await releaseStaleAttention(dataRoot, marker.provider, marker.sessionDir)
    }
  }
  await publishAttentionIndexReady(dataRoot)
  return markedSessions(dataRoot)
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
  const sessionKey = basename(sessionDir)
  await withSessionAttentionLock(dataRoot, provider, sessionKey, async () => {
    if (await sessionHasPendingEvidence(sessionDir)) return
    await clearSessionAttention(dataRoot, provider, sessionKey)
  })
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
  // An uninitialized index means unknown, not an empty workspace. Diagnostic readers rebuild it:
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
