import { listWorkspace, readWorkspaceFilePage } from '../workspace-files'
import { readWorkspaceGitDiff, type WorkspaceGitDiff } from '../git'
import type { WorkspaceFilePage, WorkspaceListResult } from '../../shared/workspace'
import type { WorkspaceAuthorizer } from './remote-run-policy'
import type { ActiveRun } from '../../shared/trace'

export type RemoteSessionStatusQuery = {
  cwd: string
  providerId: string
  externalSessionId: string
  agentProfileId?: string
}
export type RemoteSessionStatus = 'running' | 'waiting' | 'not_observed'
export type RemoteWorkspaceQuery =
  | { action: 'list'; cwd: string; path: string; cursor?: string }
  | { action: 'file'; cwd: string; path: string; offset?: number; snapshot?: string }
  | { action: 'diff'; cwd: string }
  | ({ action: 'status' } & RemoteSessionStatusQuery)
export type RemoteWorkspaceResult =
  | { action: 'list'; listing: WorkspaceListResult }
  | { action: 'file'; file: WorkspaceFilePage }
  | { action: 'diff'; diff: WorkspaceGitDiff }
  | { action: 'status'; state: RemoteSessionStatus; observedAt: string }

export function observeSessionStatus(query: RemoteSessionStatusQuery, runs: readonly ActiveRun[]): RemoteSessionStatus {
  const matches = runs.filter((run) => !run.done && run.providerId === query.providerId
    && run.cwd === query.cwd && run.externalSessionId === query.externalSessionId
    && (run.agentProfileId ?? null) === (query.agentProfileId ?? null))
  if (matches.some((run) => run.pendingQuestions?.length)) return 'waiting'
  return matches.length ? 'running' : 'not_observed'
}

export function parseRemoteWorkspaceQuery(value: unknown): RemoteWorkspaceQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request')
  const q = value as Record<string, unknown>
  const text = (key: string, optional = false): string | undefined => {
    const field = q[key]
    if (optional && field === undefined) return undefined
    if (typeof field !== 'string' || field.length > 4096 || field.includes('\0')) throw new Error('invalid_request')
    return field
  }
  const cwd = text('cwd')!
  if (!cwd) throw new Error('invalid_request')
  switch (q.action) {
    case 'list': return { action: 'list', cwd, path: text('path')!, cursor: text('cursor', true) }
    case 'file': {
      if (q.offset !== undefined && (!Number.isSafeInteger(q.offset) || (q.offset as number) < 0)) throw new Error('invalid_request')
      return { action: 'file', cwd, path: text('path')!, offset: q.offset as number | undefined, snapshot: text('snapshot', true) }
    }
    case 'diff': return { action: 'diff', cwd }
    case 'status': {
      const providerId = text('providerId')!, externalSessionId = text('externalSessionId')!
      if (!providerId || !externalSessionId) throw new Error('invalid_request')
      return { action: 'status', cwd, providerId, externalSessionId, agentProfileId: text('agentProfileId', true) }
    }
    default: throw new Error('invalid_request')
  }
}

export async function readRemoteWorkspace(
  authority: WorkspaceAuthorizer,
  query: RemoteWorkspaceQuery,
  sessionStatus?: (query: RemoteSessionStatusQuery) => RemoteSessionStatus
): Promise<RemoteWorkspaceResult> {
  // Grant authentication belongs to the gateway. Re-authorize canonical cwd on
  // EVERY read, including continuation pages. File helpers enforce containment.
  const cwd = authority.authorize(query.cwd)
  let result: RemoteWorkspaceResult
  switch (query.action) {
    case 'list': result = { action: 'list', listing: await listWorkspace({ ...query, cwd, limit: 100 }) }; break
    case 'file': result = { action: 'file', file: await readWorkspaceFilePage({ ...query, cwd, limit: 64 * 1024 }) }; break
    case 'diff': result = { action: 'diff', diff: await readWorkspaceGitDiff(cwd) }; break
    case 'status':
      if (!sessionStatus) throw new Error('session_status_unavailable')
      result = { action: 'status', state: sessionStatus({ ...query, cwd }), observedAt: new Date().toISOString() }
  }
  // JSON escaping can expand text sixfold. Keep one response below the Swift
  // one-shot lane bound; never silently drop entries or call truncation clean.
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new Error('workspace_response_too_large')
  return result
}
