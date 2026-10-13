import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { AgentTurnRecord } from '../../shared/turn-record.js'
import type { GitTurnDiffCapture } from './git.js'
import { listFiles, readJson, withDirectoryLock } from './io.js'
import { safeKey } from './store.js'

export interface RecorderSessionState {
  schemaVersion: 1
  lastGeneration: number
  lastTurnIndex: number
  lastCommittedRecordId?: string
  committedProviderTurnIds?: string[]
}

export interface RecorderOpenTurnState {
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
  continuationProviderTurnIds?: string[]
  managedByScry?: boolean
  staleTerminalProtection?: boolean
  deferredTerminalAt?: string
  deferredTerminalEventId?: string
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
  return withDirectoryLock(recorderSessionLock(dataRoot, provider, sessionId), async () => {
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

export async function recorderPendingHealth(
  dataRoot: string
): Promise<{ pendingCount: number; oldestPendingAgeMs: number }> {
  let pendingCount = 0
  let oldestPendingAgeMs = 0
  const now = Date.now()
  for (const provider of ['claude', 'codex', 'qoder', 'opencode', 'pi'] as const) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    for (const session of await listFiles(providerRoot)) {
      const root = join(providerRoot, session)
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
  for (const provider of ['claude', 'codex', 'qoder', 'opencode', 'pi'] as const) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    for (const session of await listFiles(providerRoot)) {
      const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(join(providerRoot, session)))
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
  for (const provider of ['claude', 'codex', 'qoder', 'opencode', 'pi'] as const) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    for (const session of await listFiles(providerRoot)) {
      try {
        await access(recorderOpenPath(join(providerRoot, session)))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
      }
      // A hook queued behind a busy session lock still needs a recovery pass to be applied.
      if ((await listFiles(join(providerRoot, session, 'inbox'))).some((name) => name.endsWith('.json'))) return true
    }
  }
  return false
}
