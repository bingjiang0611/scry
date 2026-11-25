import { access, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import type { TurnDiffSnapshot } from '../../shared/trace.js'
import type { GitTurnDiffCapture } from './git.js'
import type { RepositoryDiscovery } from './config.js'
import { readJson, withDirectoryLock, writeJsonAtomic } from './io.js'
import { hostProcessState, processTable, type HostProcessState, type ProcessTableEntry } from './host-process.js'
import {
  ATTENTION_PROVIDERS, attentionIndexPresent, clearSessionAttention, markSessionAttention,
  markedSessions, publishAttentionIndexReady, withSessionAttentionLock, type MarkedSession
} from './attention.js'
import { safeKey } from './store.js'
import { recorderHasRetryableInbox, recorderInboxEntries } from './inbox.js'
import {
  clearSessionFailure, isUnusableSessionError, noteSessionFailure, readSessionFailures, sessionFailureKey,
  suspendedSessionKeys
} from './session-failures.js'

export interface RecorderSealedSegment {
  recordId: string
  rootRecordId: string
  at: string
  providerTurnId?: string
  transcriptPath?: string
  publishedEvents?: number
  frozenDiffs?: RecorderFrozenDiff[]
}

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
  chainStores?: string[]
  captureRepositories?: string[]
  lastSegment?: RecorderSealedSegment
}

export interface RecorderContinuation {
  rootRecordId: string
  sealedRecordId: string
  publishedEvents?: number
  providerTurnId?: string
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
  initialization?: 'pending' | 'complete'
  startedAt: string
  closingAt?: string
  terminalAt?: string
  terminalAtSource?: 'provider_terminal_event' | 'recorder_observed_terminal'
  terminalFallbackStatus?: AgentTurnRecord['status']
  stopObservedAt?: string
  stopObservedAtSource?: 'provider_terminal_event' | 'recorder_observed_terminal'
  endReason?: import('../../shared/turn-record.js').TurnEndReason
  prompt?: string
  promptHash?: string
  managedRunId?: string
  managedPromptHash?: string
  startFingerprint: string
  transcriptPath?: string
  /** Byte where this turn's rows begin; `null` when the recorder could not read it. Never a guess. */
  transcriptStartOffset?: number | null
  piTranscriptAnchor?: import('./recorder-contracts.js').PiTranscriptAnchor
  providerTurnId?: string
  requestSetId?: string
  terminalDiffs?: Array<{ repository: string; snapshot: TurnDiffSnapshot }>
  continuationProviderTurnIds?: string[]
  managedByScry?: boolean
  host?: import('./host-process.js').HostProcess[]
  staleTerminalProtection?: boolean
  deferredTerminalAt?: string
  deferredTerminalEventId?: string
  deferredTerminalReason?: 'stale_terminal' | 'pending_background_tasks'
  continuation?: RecorderContinuation
  frozenDiffs?: RecorderFrozenDiff[]
  terminalIdentityConfirmedBySessionEnd?: boolean
  sessionEndedAt?: string
  repositoryDiscovery?: Pick<RepositoryDiscovery, 'maxDepth' | 'depthLimitedDirectories' | 'worktreeDiscovery'>
  captures: Array<{ repository: string; capture: GitTurnDiffCapture }>
  capture?: {
    protocol: string
    captureId: string
    source: string
    task: string | null
    client?: string
    openedAt: string
    diffExclude?: string[]
    baselineAt?: string
  }
  captureStopRequestedAt?: string
  captureTranscriptEndOffset?: number
}

export const SESSION_LOCK_WAIT_MS = 10_000
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

export function withRecorderSessionKeyLock<T>(
  dataRoot: string, provider: ProviderId, sessionKey: string,
  action: () => Promise<T>, options: { waitMs?: number; ttlMs?: number } = {}
): Promise<T> {
  return withDirectoryLock(join(dataRoot, 'locks', 'sessions', provider, `${sessionKey}.lock`), async () => {
    await withDirectoryLock(join(dataRoot, 'locks', 'maintenance.lock'), async () => {}, options)
    return action()
  }, options)
}

export function recorderQuarantineIndexPath(root: string): string {
  return join(dirname(dirname(dirname(root))), 'quarantine-index', basename(dirname(root)), `${basename(root)}.json`)
}

async function quarantineGenerations(root: string, reconcile = false): Promise<string[]> {
  const indexed = await readJson<string[]>(recorderQuarantineIndexPath(root))
  if (!reconcile && Array.isArray(indexed) && indexed.every(value =>
    typeof value === 'string' && basename(value) === value && value !== '.' && value !== '..'
  )) return indexed
  const generations: string[] = []
  const entries = await readdir(join(root, 'turns'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const exists = await stat(join(root, 'turns', entry.name, 'pending-open.json')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (exists) generations.push(entry.name)
  }
  await writeJsonAtomic(recorderQuarantineIndexPath(root), generations)
  return generations
}

export async function publishQuarantinedOpenTurn(
  root: string, open: RecorderOpenTurnState & { quarantinedAt: string; reason: string }
): Promise<void> {
  await withDirectoryLock(`${recorderQuarantineIndexPath(root)}.lock`, async () => {
    const generations = await quarantineGenerations(root)
    const generation = basename(recorderTurnRoot(root, open.generation))
    if (!generations.includes(generation)) {
      await writeJsonAtomic(recorderQuarantineIndexPath(root), [...generations, generation])
    }
    await writeJsonAtomic(join(root, 'turns', generation, 'pending-open.json'), open, { sync: false })
  })
}

export async function recorderQuarantinedOpenTurns(
  root: string, options: { reconcile?: boolean } = {}
): Promise<RecorderOpenTurnState[]> {
  return withDirectoryLock(`${recorderQuarantineIndexPath(root)}.lock`, async () => {
    const generations = await quarantineGenerations(root, options.reconcile)
    const result: RecorderOpenTurnState[] = []
    const retained: string[] = []
    for (const generation of generations) {
      const path = join(root, 'turns', generation, 'pending-open.json')
      const open = await readJson<RecorderOpenTurnState>(path)
      if (open) result.push(open)
      if (open || await pathExists(path)) retained.push(generation)
    }
    if (retained.length !== generations.length) await writeJsonAtomic(recorderQuarantineIndexPath(root), retained)
    return result
  })
}

export async function reconcileAttentionIndex(dataRoot: string): Promise<MarkedSession[]> {
  const indexed = new Set((await markedSessions(dataRoot)).map(marker => `${marker.provider}__${marker.sessionKey}`))
  const failures = await readSessionFailures(dataRoot)
  const suspended = suspendedSessionKeys(failures)
  // A session this scan could not read leaves the index unproven, so it may not publish readiness.
  let incomplete = false
  const live = new Set<string>()
  for (const provider of ATTENTION_PROVIDERS) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    const entries = await readdir(providerRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionKey = entry.name
      const sessionDir = join(providerRoot, sessionKey)
      const key = sessionFailureKey(provider, sessionKey)
      live.add(`${provider}__${sessionKey}`)
      // A suspended session keeps its marker untouched: its failure is already reported, and this
      // scan has nothing new to decide about it.
      if (suspended.has(key)) continue
      try {
        await recorderQuarantinedOpenTurns(sessionDir, { reconcile: true })
        if (indexed.has(`${provider}__${sessionKey}`) || await sessionHasPendingEvidence(sessionDir)) {
          await withSessionAttentionLock(dataRoot, provider, sessionKey, async () => {
            if (await sessionHasPendingEvidence(sessionDir)) {
              await markSessionAttention(dataRoot, provider, sessionKey)
            } else {
              await clearSessionAttention(dataRoot, provider, sessionKey)
            }
          })
        }
        // Readable again: whatever it failed to enumerate before was transient after all. A failure
        // inside the turn is not this scan's to clear.
        await clearSessionFailure(dataRoot, provider, sessionKey, { present: key in failures, scope: 'session' })
      } catch (error) {
        // One unreadable session must not starve the rebuild for every other one; readiness waits.
        // A read error inside a turn is not an unreadable entry, and still stops the scan here.
        if (!isUnusableSessionError(error)) throw error
        incomplete = true
        // Diagnostics never block the rebuild, and readiness stays withheld either way.
        await noteSessionFailure(dataRoot, provider, sessionKey, error).catch(() => undefined)
      }
    }
  }
  for (const marker of await markedSessions(dataRoot)) {
    if (!live.has(`${marker.provider}__${marker.sessionKey}`)) {
      await releaseStaleAttention(dataRoot, marker.provider, marker.sessionDir)
    }
  }
  if (!incomplete) await publishAttentionIndexReady(dataRoot)
  return markedSessions(dataRoot)
}

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

async function sessionHasPendingEvidence(sessionDir: string): Promise<boolean> {
  if (await pathExists(recorderOpenPath(sessionDir))) return true
  if ((await recorderInboxEntries(sessionDir)).length > 0) return true
  return (await recorderQuarantinedOpenTurns(sessionDir)).length > 0
}

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
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

async function attentionSessions(dataRoot: string): Promise<MarkedSession[]> {
  return await attentionIndexPresent(dataRoot)
    ? await markedSessions(dataRoot)
    : await reconcileAttentionIndex(dataRoot)
}

/**
 * Sessions a reader may describe right now: the index, minus the ones suspended for repeating the
 * same failure. Suspension is a report about retries, not evidence about the turn.
 */
async function sessionsToVisit(dataRoot: string): Promise<{ sessions: MarkedSession[]; suspendedSessions: number }> {
  const suspended = suspendedSessionKeys(await readSessionFailures(dataRoot))
  const all = await attentionSessions(dataRoot)
  const sessions = all.filter(session => !suspended.has(sessionFailureKey(session.provider, session.sessionKey)))
  return { sessions, suspendedSessions: all.length - sessions.length }
}

export const STALE_OPEN_TURN_QUIET_MS = 30 * 60 * 1_000

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
  host?: 'running' | 'gone' | 'unknown'
}

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

const eventClockCache = new Map<string, { identity: string; newest: number | undefined }>()

async function turnLastEventAt(sessionDir: string, open: RecorderOpenTurnState): Promise<number | undefined> {
  const eventsDir = join(recorderTurnRoot(sessionDir, open.generation), 'events')
  const directoryIdentity = async (): Promise<string | undefined> => {
    const info = await stat(eventsDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) return undefined
    const state = await stat(recorderOpenPath(sessionDir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${state?.ino}:${state?.mtimeMs}:${state?.ctimeMs}`
  }
  const identity = await directoryIdentity()
  if (!identity) return undefined
  const cached = eventClockCache.get(eventsDir)
  if (cached?.identity === identity) return cached.newest
  const names = await readdir(eventsDir)
  let newest: number | undefined
  for (const name of names) {
    const touched = (await stat(join(eventsDir, name))).mtimeMs
    if (Number.isFinite(touched) && (newest === undefined || touched > newest)) newest = touched
  }
  if (await directoryIdentity() === identity) {
    eventClockCache.delete(eventsDir)
    eventClockCache.set(eventsDir, { identity, newest })
    if (eventClockCache.size > 128) eventClockCache.delete(eventClockCache.keys().next().value!)
  }
  return newest
}

export async function recorderPendingHealth(
  dataRoot: string
): Promise<{ pendingCount: number; oldestPendingAgeMs: number; openTurns: number; staleOpenTurns: number; suspendedSessions: number }> {
  let pendingCount = 0
  let oldestPendingAgeMs = 0
  let openTurns = 0
  let staleOpenTurns = 0
  const now = Date.now()
  const { sessions, suspendedSessions } = await sessionsToVisit(dataRoot)
  for (const session of sessions) {
    const root = session.sessionDir
    try {
      for (const entry of await recorderInboxEntries(root)) {
        pendingCount++
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
      if (open) {
        openTurns++
        const { quietMs } = await openTurnQuiet(root, open, now)
        const silence = Number.isFinite(quietMs) ? quietMs : now - (Date.parse(open.startedAt) || now)
        if (open.status === 'open' && !open.managedByScry && silence >= STALE_OPEN_TURN_QUIET_MS) staleOpenTurns++
      }
    } catch (error) {
      if (!isUnusableSessionError(error)) throw error
      await noteSessionFailure(dataRoot, session.provider, session.sessionKey, error).catch(() => undefined)
    }
  }
  // A session suspended during this pass is not in this snapshot. It shows up next pass.
  return { pendingCount, oldestPendingAgeMs, openTurns, staleOpenTurns, suspendedSessions }
}

export async function recorderStaleOpenTurns(
  dataRoot: string,
  expiryMs: number,
  now = Date.now()
): Promise<Array<{
  provider: ProviderId
  sessionId: string
  startedAt: string
  ageMs: number
  lastEventAt?: string
  quietMs: number
  growing: boolean
  host?: HostProcessState
}>> {
  const result: Awaited<ReturnType<typeof recorderStaleOpenTurns>> = []
  let table: Map<number, ProcessTableEntry> | undefined
  let tableRead = false
  const hostTable = async (): Promise<Map<number, ProcessTableEntry> | undefined> => {
    if (!tableRead) { tableRead = true; table = await processTable() }
    return table
  }
  for (const { provider, sessionDir } of (await sessionsToVisit(dataRoot)).sessions) {
    try {
      const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(sessionDir))
      if (!open || open.status !== 'open' || open.managedByScry) continue
      const startedAt = Date.parse(open.startedAt)
      if (!Number.isFinite(startedAt) || now - startedAt <= expiryMs) continue
      if (open.transcriptPath) {
        const touchedAt = await transcriptTouchedAt(open.transcriptPath)
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
    } catch (error) {
      if (!isUnusableSessionError(error)) throw error
    }
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

export async function recorderHasOpenTurn(dataRoot: string): Promise<boolean> {
  const { sessions } = await sessionsToVisit(dataRoot)
  for (const session of sessions) {
    try {
      if (await sessionNeedsPass(session.sessionDir)) return true
    } catch (error) {
      // Unreadable means unknown, not done: the pass that follows records the failure and, after the
      // threshold, suspends the session so this answer can finally be `false`.
      if (!isUnusableSessionError(error)) throw error
      return true
    }
  }
  return false
}
