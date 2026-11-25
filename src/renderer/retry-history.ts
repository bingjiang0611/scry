import type { ProjectMeta } from '../preload'

/**
 * The row behind an evidence gap, when the gap's session is one this window can still see. Kept out
 * of the interaction wiring file: the lookup is its own small rule (match session id, then cwd).
 */
export function retryHistoryFor(
  projects: readonly ProjectMeta[],
  activeSessionId: string | null,
  cwd: string | null
) {
  if (!activeSessionId) return undefined
  return projects
    .flatMap((project) => project.sessions.map((row) => ({ cwd: row.cwd ?? project.cwd, row })))
    .find((entry) => entry.row.sessionId === activeSessionId && entry.cwd === cwd)
}

/** The same lookup, only while the evidence gap is an error: otherwise there is nothing to retry. */
export function retryHistoryAction(
  projects: readonly ProjectMeta[],
  activeSessionId: string | null,
  cwd: string | null,
  gapStatus: string | undefined
) {
  return gapStatus === 'error' ? retryHistoryFor(projects, activeSessionId, cwd) : undefined
}
