import { app, type BrowserWindow } from 'electron'
import { realpathSync } from 'node:fs'
import type { ProviderId } from '../../shared/provider'
import type { ActiveRun } from '../../shared/trace'
import { sessionAttentionKey } from '../../shared/session-attention'
import { DockBadgeState } from '../dock-badge'
import { SessionDiffBaselineRegistry } from '../session-diff'
import { ContextAdmission } from '../context-admission'
import { ProviderOperationGate, providerOperationKey } from '../provider-operation-gate'
import { mirrorTranscript } from '../transcript-archive'

export async function mirrorSessionTranscript(providerId: ProviderId, cwd: string | undefined, sessionId: string | undefined): Promise<void> {
  if (providerId !== 'claude' || !cwd || !sessionId) return
  try {
    const ok = await mirrorTranscript({ cwd, sessionId, userDataDir: app.getPath('userData') })
    if (!ok) console.warn('[scry] transcript mirror skipped:', cwd, sessionId)
  } catch (error) {
    console.warn('[scry] transcript mirror failed:', cwd, sessionId, error)
  }
}

export function createSessionState(getWindow: () => BrowserWindow | null) {
  // 每个 Provider + cwd 维护各自的会话；空 cwd 是“不绑定项目”的持久会话作用域。
  const sessionByContext = new Map<string, string>()
  const sessionRevisionByContext = new Map<string, number>()
  const sessionAliasesByContext = new Map<string, Map<string, string>>()
  // Both local and remote runs own baselines by provider/profile/cwd/session.
  // Selection revisions cannot rename or discard a different run's Git capture.
  const sessionDiffBaselines = new SessionDiffBaselineRegistry()
  const sessionBaselineKey = (context: string, sessionId: string): string => JSON.stringify([context, 'session', sessionId])
  const contextAdmission = new ContextAdmission()
  const recordingBlockedSessions = new Map<string, string>()
  const providerOperationGate = new ProviderOperationGate()
  const recordingRecoveryHint = '不要开始下一轮；保留 userData/trace-turn-progress、managed-turn-progress、managed-turn-commits 与 workspace/.scry 后重试恢复'
  const deletingSessions = new Set<string>()
  const adoptingSessionKeys = new Set<string>()
  const providerContextKey = (providerId: ProviderId, cwd: string, agentProfileId?: string): string =>
    `${providerId}\0${agentProfileId ?? ''}\0${cwd}`
  const withProviderOperation = async <T>(
    providerId: ProviderId,
    operation: () => T | Promise<T>,
    agentProfileId?: string
  ): Promise<T> => {
    const lease = providerOperationGate.acquireOperation(providerOperationKey(providerId, agentProfileId))
    if (!lease.ok) throw new Error('当前 Provider 正在认证 MCP，请等待认证完成或超时后重试')
    try {
      return await operation()
    } finally {
      lease.release()
    }
  }
  const canonicalProviderCwd = (cwd?: string): string => {
    try {
      return realpathSync(cwd ?? process.cwd())
    } catch {
      return cwd ?? process.cwd()
    }
  }
  const providerSessionKey = (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string): string =>
    sessionAttentionKey({ providerId, agentProfileId, cwd, sessionId })
  let badgePermissionWarningShown = false
  const dockBadge = new DockBadgeState((count) => {
    if (app.setBadgeCount(count) || process.platform !== 'darwin' || badgePermissionWarningShown) return
    badgePermissionWarningShown = true
    console.warn('[scry] macOS Dock badge permission is unavailable')
  }, (snapshot) => {
    try {
      getWindow()?.webContents.send('agent:unreadSessions', snapshot)
    } catch (error) {
      console.warn('[scry] unread session notification failed:', error)
    }
  })
  const activeRunSessionKey = (run: ActiveRun): string | null => {
    if (!run.providerId) return null
    return providerSessionKey(
      run.providerId,
      run.cwd ?? '',
      run.externalSessionId ?? run.sessionId ?? run.runId,
      run.agentProfileId
    )
  }


  function bumpSessionRevision(key: string): void {
    sessionRevisionByContext.set(key, (sessionRevisionByContext.get(key) ?? 0) + 1)
  }

  function resetSessionContext(key: string): void {
    bumpSessionRevision(key)
    sessionByContext.delete(key)
    sessionAliasesByContext.delete(key)
  }


  return {
    sessionByContext, sessionRevisionByContext, sessionAliasesByContext,
    sessionDiffBaselines, sessionBaselineKey, contextAdmission, recordingBlockedSessions,
    providerOperationGate, recordingRecoveryHint, deletingSessions, adoptingSessionKeys,
    providerContextKey, providerSessionKey, canonicalProviderCwd, withProviderOperation,
    dockBadge, activeRunSessionKey, bumpSessionRevision, resetSessionContext
  }
}
