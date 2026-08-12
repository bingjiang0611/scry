import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { GitTurnDiffCapture } from './git.js'
import { listFiles, readJson } from './io.js'
import { safeKey } from './store.js'

export interface RecorderSessionState {
  schemaVersion: 1
  lastGeneration: number
  lastTurnIndex: number
  lastCommittedRecordId?: string
  committedProviderTurnIds?: string[]
}

export interface RecorderOpenTurnState {
  schemaVersion: 1
  provider: ProviderId
  sessionId: string
  generation: number
  turnIndex: number
  status: 'open' | 'closing'
  startedAt: string
  closingAt?: string
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
  captures: Array<{ repository: string; capture: GitTurnDiffCapture }>
}

export const SESSION_LOCK_WAIT_MS = 10_000

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
  for (const provider of ['claude', 'codex', 'qoder', 'opencode'] as const) {
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

export async function recorderHasOpenTurn(dataRoot: string): Promise<boolean> {
  for (const provider of ['claude', 'codex', 'qoder', 'opencode'] as const) {
    const providerRoot = join(dataRoot, 'runtime', provider)
    for (const session of await listFiles(providerRoot)) {
      try {
        await access(recorderOpenPath(join(providerRoot, session)))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
      }
    }
  }
  return false
}
