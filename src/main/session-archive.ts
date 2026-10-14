import type { ActiveRun } from '../shared/trace'
import type { AppSessionRef, createAppSessionStore } from './app-store'

// Persist first to fence queued/in-flight starts. Stop only registered runs belonging
// to this exact Provider/profile/workspace/session, including provisional run IDs.
export function archiveSessionAndStop(
  store: ReturnType<typeof createAppSessionStore>,
  ref: AppSessionRef,
  activeRuns: readonly ActiveRun[],
  stopRun: (runId: string) => boolean
): boolean {
  if (!store.setArchived(ref, true)) return false
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
