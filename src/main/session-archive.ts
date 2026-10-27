import type { ActiveRun } from '../shared/trace'
import { sessionAttentionKey } from '../shared/session-attention'
import type { AppSessionRef, createAppSessionStore } from './app-store'

// Persist first to fence queued/in-flight starts. Stop only registered runs belonging
// to this exact Provider/profile/workspace/session, including provisional run IDs.
export function archiveSessionAndStop(
  store: ReturnType<typeof createAppSessionStore>,
  ref: AppSessionRef,
  activeRuns: readonly ActiveRun[],
  stopRun: (runId: string) => boolean,
  releaseAttention?: (sessionKey: string) => void
): boolean {
  if (!store.setArchived(ref, true)) return false
  // 存档会话会从侧栏消失，再没有入口能让用户「查看」它，未读角标必须同时释放；否则这个 key
  // 会留在进程内存里直到重启，Dock 角标就再也降不下来。
  releaseAttention?.(sessionAttentionKey({
    providerId: ref.providerId,
    agentProfileId: ref.agentProfileId,
    cwd: ref.cwd,
    sessionId: ref.externalSessionId
  }))
  const archived = store.load().find((session) => session.archivedAt &&
    session.providerId === ref.providerId && session.agentProfileId === ref.agentProfileId &&
    session.cwd === ref.cwd &&
    (session.sessionId === ref.externalSessionId || session.externalSessionId === ref.externalSessionId))!
  const matchingRuns = activeRuns.filter((run) =>
    run.providerId === ref.providerId && run.agentProfileId === ref.agentProfileId && run.cwd === ref.cwd &&
    (run.runId === archived.runId || run.runId === ref.externalSessionId ||
      run.externalSessionId === ref.externalSessionId || run.sessionId === ref.externalSessionId)
  )
  for (const run of matchingRuns) stopRun(run.runId)
  return true
}
