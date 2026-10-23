import type { createAppSessionStore } from './app-store'
import { discoverTraceArchiveSessionsAsync } from './transcript-archive'

type RecoveryStore = Pick<ReturnType<typeof createAppSessionStore>, 'load' | 'record'>

/**
 * Records Qoder sessions that exist only in Scry's per-turn archives, for workspaces the catalog
 * already knows. Recovery targets the Qoder catalog gap that loses otherwise healthy native
 * sessions, so only the Qoder archive subtree is scanned. Returns how many sessions were added.
 */
export async function recoverQoderCatalogSessions(userDataDir: string, store: RecoveryStore): Promise<number> {
  const catalog = store.load()
  const knownCwds = new Set(catalog.map((session) => session.cwd))
  const known = new Set(catalog.flatMap((session) =>
    session.externalSessionId
      ? [`${session.providerId}\0${session.agentProfileId ?? ''}\0${session.cwd}\0${session.externalSessionId}`]
      : []
  ))
  let recovered = 0
  for (const summary of await discoverTraceArchiveSessionsAsync(userDataDir, ['qoder'])) {
    // Never resurrect archived regression evidence as new projects.
    if (summary.providerId !== 'qoder' || !knownCwds.has(summary.cwd)) continue
    const key = `${summary.providerId}\0\0${summary.cwd}\0${summary.sessionId}`
    if (known.has(key)) continue
    store.record({
      providerId: summary.providerId,
      runtimeProvider: summary.runtimeProvider,
      runId: summary.runId,
      externalSessionId: summary.sessionId,
      cwd: summary.cwd,
      prompt: summary.prompt
    })
    known.add(key)
    recovered++
  }
  return recovered
}
