import { access, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import type { TurnDiffSnapshot } from '../../shared/trace.js'
import type { GitTurnDiffCapture } from './git.js'
import type { RepositoryDiscovery } from './config.js'
import { listFiles, readJson, withDirectoryLock } from './io.js'
import { hostProcessState, processTable, type HostProcessState, type ProcessTableEntry } from './host-process.js'
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
  /**
   * Object stores kept alive for the active segment chain. A continuation's baseline tree can name
   * blobs from any earlier segment of the same chain, so they are released only when a real user
   * prompt starts a new chain (or the session state stops naming them).
   */
  chainStores?: string[]
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
  /**
   * When this turn's own Stop was observed, and whose clock said so. A hold that later background
   * work cancels keeps the fact: the turn did reach its terminal, so a following prompt supersedes a
   * completed turn, and the ending it reported is the end time. A session end is not a Stop and does
   * not set it.
   */
  stopObservedAt?: string
  stopObservedAtSource?: 'provider_terminal_event' | 'recorder_observed_terminal'
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
  /**
   * The processes this turn's host sat in when it opened, nearest first. Only an observation taken
   * at start time: recovery can say a recorded host is still running, never that the session is alive.
   */
  host?: import('./host-process.js').HostProcess[]
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
    /** Absolute paths this session keeps out of its diffs; only the diff is affected. */
    diffExclude?: string[]
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

/** How long an open turn must be silent before its own finished reply counts as its end. */
export const STALE_OPEN_TURN_QUIET_MS = 30 * 60 * 1_000

/**
 * What one open turn still owes the store, in the terms a reader can check.
 *
 * `lastEventAt` and `quietMs` come from the files the turn actually wrote (its stored events and its
 * transcript), never from wall-clock age alone: a turn waiting on a long tool keeps growing, and one
 * whose host died stops. `stale` is just "silent past the threshold" — it is not a verdict, because
 * ending a turn needs evidence of its own.
 */
export interface RecorderOpenTurnInspection {
  provider: ProviderId
  sessionId: string
  status: 'open' | 'closing'
  managed: boolean
  startedAt: string
  ageMs: number
  lastEventAt?: string
  quietMs: number
  growing: boolean
  stale: boolean
  /**
   * Whether the processes that hosted this stale turn at start are still there. Set only for stale
   * turns, and only because `recover --expire-open` needs `gone` before it closes anything: the
   * operator needs to see why a silent turn stayed open (`running`, or `unknown` for no evidence).
   */
  host?: 'running' | 'gone' | 'unknown'
}

/** When this turn last wrote anything, and how long ago that was. Shared by health and recovery. */
export async function openTurnQuiet(
  sessionDir: string,
  open: RecorderOpenTurnState,
  now = Date.now()
): Promise<{ lastAt?: number; quietMs: number }> {
  const lastAt = Math.max(
    await turnLastEventAt(sessionDir, open) ?? 0,
    (open.transcriptPath ? await transcriptTouchedAt(open.transcriptPath) : null) ?? 0
  )
  return lastAt ? { lastAt, quietMs: Math.max(0, now - lastAt) } : { quietMs: Number.POSITIVE_INFINITY }
}

/**
 * Every open turn in the workspace. A diagnostic: it stats stored events and transcripts, so the
 * callers are CLI commands and health refreshes, never the hook hot path.
 */
export async function recorderOpenTurns(
  dataRoot: string,
  options: { now?: number; quietMs?: number } = {}
): Promise<RecorderOpenTurnInspection[]> {
  const now = options.now ?? Date.now()
  const quietThreshold = options.quietMs ?? STALE_OPEN_TURN_QUIET_MS
  const result: RecorderOpenTurnInspection[] = []
  for (const { provider, sessionDir } of await attentionSessions(dataRoot)) {
    const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(sessionDir))
    if (!open) continue
    const startedMs = Date.parse(open.startedAt)
    const { lastAt, quietMs } = await openTurnQuiet(sessionDir, open, now)
    result.push({
      provider,
      sessionId: open.sessionId,
      status: open.status,
      managed: open.managedByScry === true,
      startedAt: open.startedAt,
      ageMs: Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0,
      ...(lastAt ? { lastEventAt: new Date(lastAt).toISOString() } : {}),
      quietMs: Number.isFinite(quietMs) ? quietMs : 0,
      growing: quietMs < quietThreshold,
      stale: open.status === 'open' && !open.managedByScry && quietMs >= quietThreshold
    })
  }
  // One process table read for every stale turn in this workspace, and none when nothing is stale.
  const waiting = result.filter((turn) => turn.stale)
  if (waiting.length) {
    const table = await processTable()
    for (const turn of waiting) {
      const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(join(dataRoot, 'runtime', turn.provider, safeKey(turn.sessionId))))
      turn.host = await hostProcessState(open?.host, table)
    }
  }
  return result
}

/** The newest stored event this turn wrote; its transcript is the other half of "is it moving". */
async function turnLastEventAt(sessionDir: string, open: RecorderOpenTurnState): Promise<number | undefined> {
  const eventsDir = join(recorderTurnRoot(sessionDir, open.generation), 'events')
  const names = await readdir(eventsDir).catch(() => [] as string[])
  let newest: number | undefined
  for (const name of names) {
    const touched = await stat(join(eventsDir, name)).then((info) => info.mtimeMs, () => Number.NaN)
    if (Number.isFinite(touched) && (newest === undefined || touched > newest)) newest = touched
  }
  return newest
}

export async function recorderPendingHealth(
  dataRoot: string
): Promise<{ pendingCount: number; oldestPendingAgeMs: number; openTurns: number; staleOpenTurns: number }> {
  let pendingCount = 0
  let oldestPendingAgeMs = 0
  let openTurns = 0
  let staleOpenTurns = 0
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
      // An open turn that never reached `closing` is not "pending finalization" — nothing is waiting
      // to be committed — but it is the turn a reader means by "still open", and the one that goes
      // missing from a count that only looks at closing/managed turns.
      if (open) {
        openTurns++
        const { quietMs } = await openTurnQuiet(root, open, now)
        const silence = Number.isFinite(quietMs) ? quietMs : now - (Date.parse(open.startedAt) || now)
        if (open.status === 'open' && !open.managedByScry && silence >= STALE_OPEN_TURN_QUIET_MS) staleOpenTurns++
      }
    }
  return { pendingCount, oldestPendingAgeMs, openTurns, staleOpenTurns }
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
): Promise<Array<{
  provider: ProviderId
  sessionId: string
  startedAt: string
  ageMs: number
  /** The newest thing this turn wrote, so a reader can tell "idle for a day" from "age only". */
  lastEventAt?: string
  quietMs: number
  /** Still writing inside the stale window: slow, not stuck. */
  growing: boolean
  /** Same meaning as `RecorderOpenTurnInspection.host`: why a forced expiry would not act. */
  host?: HostProcessState
}>> {
  const result: Awaited<ReturnType<typeof recorderStaleOpenTurns>> = []
  let table: Map<number, ProcessTableEntry> | undefined
  let tableRead = false
  // One process table for the whole listing: `ps` costs more than the lookups it serves.
  const hostTable = async (): Promise<Map<number, ProcessTableEntry> | undefined> => {
    if (!tableRead) { tableRead = true; table = await processTable() }
    return table
  }
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
    const { lastAt, quietMs } = await openTurnQuiet(sessionDir, open, now)
    result.push({
      provider,
      sessionId: open.sessionId,
      startedAt: open.startedAt,
      ageMs: now - startedAt,
      ...(lastAt ? { lastEventAt: new Date(lastAt).toISOString() } : {}),
      quietMs: Number.isFinite(quietMs) ? quietMs : now - startedAt,
      growing: quietMs < STALE_OPEN_TURN_QUIET_MS,
      host: await hostProcessState(open.host, await hostTable())
    })
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
