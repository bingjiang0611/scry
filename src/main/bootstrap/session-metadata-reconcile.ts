import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * D4 (R10): a rename, pin or archive is written to the catalog file first. The authority event is the
 * second half of the same user change, so an authority that is unavailable — or that throws — must not
 * turn a completed change into a failed call. The missing event is kept in a small durable queue and
 * replayed at startup, which is the only way it can be recorded once the store is writable again.
 */
export type PendingMetadataChange =
  | { kind: 'rename'; title: string }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'archive'; archived: boolean }

export interface PendingMetadataEntry {
  externalSessionId: string
  providerId: string
  agentProfileId?: string | undefined
  cwd: string
  change: PendingMetadataChange
  actor: string
}

export interface SessionMetadataRecorder {
  /** Never throws: the caller's change already happened. */
  record(entry: PendingMetadataEntry): Promise<void>
  /** Waits for the queue write that a `record` call started. */
  settled(): Promise<void>
  /** Replays queued entries; returns how many were recorded and now left the queue. */
  reconcile(): Promise<number>
}

export function createSessionMetadataRecorder(deps: {
  file: string
  record?: (entry: PendingMetadataEntry) => unknown
  warn?: (message: string, error: unknown) => void
}): SessionMetadataRecorder {
  const warn = deps.warn ?? (() => undefined)
  let writing: Promise<void> = Promise.resolve()

  const read = async (): Promise<PendingMetadataEntry[]> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(deps.file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((row): row is PendingMetadataEntry =>
        !!row && typeof row === 'object'
        && typeof (row as PendingMetadataEntry).externalSessionId === 'string'
        && typeof (row as PendingMetadataEntry).providerId === 'string'
        && typeof (row as PendingMetadataEntry).cwd === 'string'
        && typeof (row as PendingMetadataEntry).actor === 'string'
        && !!(row as PendingMetadataEntry).change)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  const write = async (entries: PendingMetadataEntry[]): Promise<void> => {
    const tmp = `${deps.file}.tmp`
    await mkdir(dirname(deps.file), { recursive: true })
    await writeFile(tmp, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, deps.file)
  }

  const serialize = <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    const pending = writing.then(work).catch((error: unknown) => {
      warn('session metadata reconciliation queue failed', error)
      return fallback
    })
    writing = pending.then(() => undefined)
    return pending
  }

  const key = (entry: PendingMetadataEntry): string => JSON.stringify([
    entry.providerId, entry.agentProfileId, entry.cwd, entry.externalSessionId, entry.change.kind
  ])

  const attempt = async (entry: PendingMetadataEntry): Promise<{ recorded: boolean; reason?: string }> => {
    if (!deps.record) return { recorded: false, reason: 'orchestration_unavailable' }
    try {
      const result = await deps.record(entry)
      const status = result && typeof result === 'object' ? (result as { status?: string; reason?: string }) : undefined
      if (status?.status === 'recorded') return { recorded: true }
      return { recorded: false, reason: status?.reason ?? 'orchestration_unavailable' }
    } catch (error) {
      warn('session metadata event failed', error)
      return { recorded: false, reason: 'metadata_record_failed' }
    }
  }

  return {
    record: (entry) => serialize(async () => {
      const entries = await read()
      // Catalog state is last-write-wins per field. An older failed update must not replay over this one.
      const remaining = entries.filter((queued) => key(queued) !== key(entry))
      const outcome = await attempt(entry)
      if (!outcome.recorded) {
        warn('session metadata event queued for reconciliation', outcome.reason)
        remaining.push(entry)
      }
      if (!outcome.recorded || remaining.length !== entries.length) await write(remaining)
    }, undefined),
    settled: () => writing,
    reconcile: () => serialize(async () => {
      const entries = await read()
      const remaining: PendingMetadataEntry[] = []
      for (const entry of entries) {
        if (!(await attempt(entry)).recorded) remaining.push(entry)
      }
      if (remaining.length !== entries.length) await write(remaining)
      return entries.length - remaining.length
    }, 0)
  }
}
