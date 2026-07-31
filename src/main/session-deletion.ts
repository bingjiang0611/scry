import type { DeleteSessionResult } from '../shared/provider'

export interface SessionDeletionDependencies {
  resolveRunIds(runIds: ReadonlySet<string>): {
    status: 'ready' | 'not_present' | 'unavailable'
    runIds: string[]
    conflicts?: string[]
    error?: string
  }
  deleteDatabase(runIds: ReadonlySet<string>): {
    status: 'deleted' | 'not_present' | 'unavailable'
    runIds: string[]
    error?: string
  }
  deleteUsage(runIds: ReadonlySet<string>): { preservedInvalid: number }
  deleteManaged?(runIds: ReadonlySet<string>): Promise<{ failed: Array<{ path: string; error: string }> }>
  deleteAttachments(runId: string): { failed?: string }
  deleteTranscripts(): { failed: Array<{ path: string; error: string }> }
  deleteCatalog(): void
}

export async function deleteOwnedSessionData(
  initialRunIds: Iterable<string>,
  dependencies: SessionDeletionDependencies
): Promise<DeleteSessionResult> {
  const candidates = new Set(initialRunIds)
  const result: DeleteSessionResult = {
    ok: false,
    deleted: [],
    retained: [
      'workspace .scry/ canonical turn evidence',
      'Provider-native session transcript/history',
      'unattributed provider billing aggregates'
    ],
    failed: []
  }

  const resolution = dependencies.resolveRunIds(candidates)
  if (resolution.status === 'unavailable') {
    result.failed.push({ store: 'database', error: resolution.error ?? 'SQLite unavailable' })
    result.reason = 'partial_failure'
    return result
  }
  if (resolution.conflicts && resolution.conflicts.length > 0) {
    result.failed.push({ store: 'run-id ownership', error: `检测到跨会话 runId：${resolution.conflicts.join(', ')}` })
    result.reason = 'partial_failure'
    return result
  }
  const runIds = new Set(resolution.runIds)

  const managed = dependencies.deleteManaged ? await dependencies.deleteManaged(runIds) : { failed: [] }
  if (managed.failed.length > 0) {
    result.failed.push(...managed.failed.map((failure) => ({ store: failure.path, error: failure.error })))
    result.reason = 'partial_failure'
    return result
  }
  result.deleted.push('recovery journals')

  try {
    const usage = dependencies.deleteUsage(runIds)
    if (usage.preservedInvalid > 0) {
      result.retained.push(`${usage.preservedInvalid} 行无法归属的损坏 usage 记录`)
    }
    result.deleted.push('usage')
  } catch (error) {
    result.failed.push({ store: 'usage', error: error instanceof Error ? error.message : String(error) })
  }

  let attachmentFailed = false
  for (const runId of runIds) {
    const deleted = dependencies.deleteAttachments(runId)
    if (deleted.failed) {
      attachmentFailed = true
      result.failed.push({ store: `attachments/${runId}`, error: deleted.failed })
    }
  }
  if (!attachmentFailed) result.deleted.push('attachments')

  // Keep archive/transcript retry metadata intact if an earlier store could not be cleared.
  if (result.failed.length === 0) {
    const transcripts = dependencies.deleteTranscripts()
    if (transcripts.failed.length > 0) {
      result.failed.push(...transcripts.failed.map((failure) => ({ store: failure.path, error: failure.error })))
    } else {
      result.deleted.push('transcripts')
    }
  }

  // Keep SQLite as the authoritative retry index until every file-backed store succeeds.
  if (result.failed.length === 0) {
    const database = dependencies.deleteDatabase(runIds)
    if (database.status === 'unavailable') {
      result.failed.push({ store: 'database', error: database.error ?? 'SQLite unavailable' })
    } else {
      result.deleted.push('database')
    }
  }

  // Catalog is the retry handle. Never remove it while another owned store reports failure.
  if (result.failed.length === 0) {
    try {
      dependencies.deleteCatalog()
      result.deleted.push('catalog')
      result.ok = true
    } catch (error) {
      result.failed.push({ store: 'catalog', error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (!result.ok) result.reason = 'partial_failure'
  return result
}
