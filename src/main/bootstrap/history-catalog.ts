import type { ProviderContext } from '../../shared/provider'
import type { SessionHistoryProjection } from '../../shared/session-history'
import type { AppSession } from '../app-store'
import { knownProjectDirectoryIfPresent } from '../workspace-authorization'

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
): { session: AppSession; projection?: ProjectedIdentity; cwd: string; matches: number; workspaceMissing: boolean } {
  // A session whose workspace was removed stays readable: its recorded path names the
  // history storage, but it is never granted as a working directory.
  const requestedCwd = context.cwd?.trim()
    ? knownProjectDirectoryIfPresent(resolveKnownProjectDirectory, context.cwd) ?? context.cwd
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
  const selectedCwd = session.cwd ? knownProjectDirectoryIfPresent(resolveKnownProjectDirectory, session.cwd) : ''
  const workspaceMissing = selectedCwd === null
  // Only the matched catalog path may identify historical storage.
  const cwd = selectedCwd ?? session.cwd
  if (requestedCwd !== undefined && requestedCwd !== cwd) throw new Error('会话工作目录与 catalog 不一致')
  return { session, projection: projected?.identity, cwd, matches, workspaceMissing }
}
