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
  record(entry: PendingMetadataEntry): void
  /** Waits for the queue write that a `record` call started. */
  settled(): Promise<void>
  /** Replays queued entries; returns how many were recorded and now left the queue. */
  reconcile(): Promise<number>
}

type RecordResult = unknown

export function createSessionMetadataRecorder(deps: {
  file: string
  record?: (entry: PendingMetadataEntry) => RecordResult
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
    } catch {
      // A missing or unreadable queue means there is nothing to replay.
      return []
    }
  }

  const write = async (entries: PendingMetadataEntry[]): Promise<void> => {
    const tmp = `${deps.file}.tmp`
    await mkdir(dirname(deps.file), { recursive: true })
    await writeFile(tmp, JSON.stringify(entries), 'utf8')
    await rename(tmp, deps.file)
  }

  /** The queue is append-only between reconciliations; two changes in flight must not lose one. */
  const append = (entry: PendingMetadataEntry): Promise<void> => {
    writing = writing.then(async () => {
      const entries = await read()
      entries.push(entry)
      await write(entries)
    }).catch((error: unknown) => warn('session metadata queue write failed', error))
    return writing
  }

  const attempt = (entry: PendingMetadataEntry): { recorded: boolean; reason?: string } => {
    if (!deps.record) return { recorded: false, reason: 'orchestration_unavailable' }
    try {
      const result = deps.record(entry)
      const status = result && typeof result === 'object' ? (result as { status?: string }).status : undefined
      if (status === undefined || status === 'recorded') return { recorded: true }
      return { recorded: false, reason: (result as { reason?: string }).reason }
    } catch (error) {
      warn('session metadata event failed', error)
      return { recorded: false, reason: 'metadata_record_failed' }
    }
  }

  return {
    record(entry) {
      const outcome = attempt(entry)
      if (outcome.recorded) return
      warn('session metadata event queued for reconciliation', { reason: outcome.reason, change: entry.change })
      void append(entry)
    },
    settled: () => writing,
    async reconcile() {
      await writing
      const entries = await read()
      if (entries.length === 0) return 0
      const remaining: PendingMetadataEntry[] = []
      let recorded = 0
      for (const entry of entries) {
        if (attempt(entry).recorded) recorded += 1
        else remaining.push(entry)
      }
      await write(remaining).catch((error: unknown) => warn('session metadata queue write failed', error))
      return recorded
    }
  }
}
