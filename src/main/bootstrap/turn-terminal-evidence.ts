import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderContext } from '../../shared/provider'
import type { createAppSessionStore } from '../app-store'
import { readTraceArchiveTurnsAsync } from '../transcript-archive'

export interface TurnTerminalEvidenceDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  resolveKnownProjectDirectory: (cwd: string) => string
  userDataDir: string
}

/**
 * 终态证据的窄查询：只读一轮归档里的终态（result / session_diff / credit_usage）。
 *
 * 总览的输入+输出、缓存命中率、成本只认终态 result；main 的焦点随会话切换移走后，终态 trace
 * 不再投递，渲染进程就会永久停在「等待 result」。这条路径刻意不碰任何会话切换副作用
 * （cwd、baseline、resume、dock badge、loadSession 的 abort 链），只补回缺失的证据。
 */
export function registerTurnTerminalEvidenceHandler(deps: TurnTerminalEvidenceDependencies): void {
  const { handleTrusted, appSessionStore, resolveKnownProjectDirectory, userDataDir } = deps
  handleTrusted('agent:turnTerminalEvidence', async (_e, payload: ProviderContext, runId: string) => {
    if (!payload.externalSessionId || !runId) return []
    // 会话身份必须先过 catalog，避免渲染进程用任意 cwd/sessionId 读归档目录。
    const catalogMatches = appSessionStore().load().filter((session) =>
      session.providerId === payload.providerId && session.agentProfileId === payload.agentProfileId &&
      (session.sessionId === payload.externalSessionId || session.externalSessionId === payload.externalSessionId)
    )
    const requestedCwd = payload.cwd?.trim() ? resolveKnownProjectDirectory(payload.cwd) : undefined
    const catalogSession = catalogMatches.length === 1
      ? catalogMatches[0]
      : catalogMatches.find((session) => requestedCwd !== undefined && session.cwd === requestedCwd)
    if (!catalogSession) return []
    const cwd = catalogSession.cwd ? resolveKnownProjectDirectory(catalogSession.cwd) : ''
    const turns = await readTraceArchiveTurnsAsync(
      { cwd, sessionId: payload.externalSessionId, providerId: payload.providerId, userDataDir },
      [runId]
    )
    return turns
      .flatMap((turn) => turn.runId === runId ? turn.items : [])
      .filter((item) => item.kind === 'harness' && (item.stage === 'result' || item.stage === 'session_diff' || item.stage === 'credit_usage'))
  })
}
