import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog } from './io.js'
import { recorderPendingHealth, recorderQuarantinedOpenTurns, recorderSessionRoot, reconcileAttentionIndex } from './runtime-state.js'
import { attentionIndexPresent, markedSessions } from './attention.js'
import { readSessionFailures, sessionFailureKey, suspendedSessionKeys, type SessionFailureLedger } from './session-failures.js'
import { updateHealth } from './store.js'

export interface RecorderRecoveryScope {
  provider: ProviderId
  sessionId: string
}

export async function recoverySessions(
  dataRoot: string,
  scope?: RecorderRecoveryScope,
  incremental = false
): Promise<{ sessions: Array<{ provider: ProviderId; sessionDir: string }>; failures: SessionFailureLedger }> {
  const failures = await readSessionFailures(dataRoot)
  const suspended = suspendedSessionKeys(failures)
  const visitable = (sessions: Array<{ provider: ProviderId; sessionDir: string }>) =>
    sessions.filter(session => !suspended.has(sessionFailureKey(session.provider, basename(session.sessionDir))))
  if (scope) {
    const sessionDir = recorderSessionRoot(dataRoot, scope.provider, scope.sessionId)
    if (!incremental) await recorderQuarantinedOpenTurns(sessionDir, { reconcile: true })
    return { sessions: [{ provider: scope.provider, sessionDir }], failures }
  }
  const initialized = await attentionIndexPresent(dataRoot)
  if (!initialized || !incremental) {
    try {
      return { sessions: visitable(await reconcileAttentionIndex(dataRoot)), failures }
    } catch (error) {
      if (!initialized || !await attentionIndexPresent(dataRoot)) throw error
      await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
        `${new Date().toISOString()} WARN attention rebuild: ${error instanceof Error ? error.message : String(error)}`
      ).catch(() => undefined)
    }
  }
  return { sessions: visitable(await markedSessions(dataRoot)), failures }
}

export async function pendingHealth(
  dataRoot: string
): Promise<{ pendingCount: number; oldestPendingAgeMs: number; openTurns: number; staleOpenTurns: number; suspendedSessions: number }> {
  return recorderPendingHealth(dataRoot)
}

export async function refreshRecorderPendingHealth(dataRoot: string): Promise<void> {
  await updateHealth(dataRoot, await pendingHealth(dataRoot))
}
