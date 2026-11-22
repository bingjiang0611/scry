import type { ProviderContext } from '../../shared/provider'
import type { SessionHistoryProjection } from '../../shared/session-history'
import type { AppSession } from '../app-store'

type ProjectedIdentity = Omit<SessionHistoryProjection, 'activeRun'>

export type ReadProjectedHistorySession = (
  context: ProviderContext,
  canonicalCwd?: string
) => { session: AppSession; identity: ProjectedIdentity } | null | undefined

export function readHistoryCatalogEntry(
  context: ProviderContext,
  resolveKnownProjectDirectory: (cwd: string) => string,
  readLegacyCatalog: () => AppSession[],
  readProjection?: ReadProjectedHistorySession
): { session: AppSession; projection?: ProjectedIdentity; cwd: string; matches: number } {
  const requestedCwd = context.cwd?.trim()
    ? resolveKnownProjectDirectory(context.cwd)
    : context.cwd === '' ? '' : undefined
  const projected = readProjection?.(context, requestedCwd)
  let session = projected?.session
  let matches = session ? 1 : 0
  if (projected === undefined) {
    const candidates = readLegacyCatalog().filter((row) =>
      row.providerId === context.providerId && row.agentProfileId === context.agentProfileId &&
      (row.sessionId === context.externalSessionId || row.externalSessionId === context.externalSessionId))
    matches = candidates.length
    session = matches === 1 ? candidates[0] : candidates.find((row) => row.cwd === requestedCwd)
  }
  if (!session) throw new Error('会话不属于当前 Scry catalog 或身份不唯一')
  const cwd = session.cwd ? resolveKnownProjectDirectory(session.cwd) : ''
  if (requestedCwd !== undefined && requestedCwd !== cwd) throw new Error('会话工作目录与 catalog 不一致')
  return { session, projection: projected?.identity, cwd, matches }
}
