import { randomUUID } from 'node:crypto'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES, type DesktopHostRead, type DesktopHostReadResult, type DesktopRemoteContext } from '../../shared/desktop-remote'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import { mergeSessionTurns } from '../session-history'
import { readTraceArchivePageAsync, readTraceArchiveVersionAsync } from '../transcript-archive'

// Leave room for the desktop transport's outer response envelope.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024 - 1024
const MAX_CACHED_BYTES = 64 * 1024 * 1024
const MAX_CACHED_PAGES = 4
const CHUNK_IDLE_MS = 60_000
const PROVIDERS: readonly string[] = ['claude', 'codex', 'qoder', 'opencode', 'pi']

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error('invalid_request')
  return value
}

export function parseDesktopHostRead(value: unknown): DesktopHostRead {
  const query = object(value)
  if (query.kind === 'info') return { kind: 'info' }
  if (query.kind !== 'history' && query.kind !== 'trace') throw new Error('invalid_request')
  const input = object(query.context)
  const providerId = text(input.providerId, 64)
  if (!PROVIDERS.includes(providerId)) throw new Error('provider_unsupported')
  const context: DesktopRemoteContext = {
    providerId,
    cwd: text(input.cwd, 4096),
    ...(input.agentProfileId === undefined ? {} : { agentProfileId: text(input.agentProfileId, 128) }),
    ...(input.externalSessionId === undefined ? {} : { externalSessionId: text(input.externalSessionId, 256) })
  }
  if (query.kind === 'trace') return { kind: 'trace', context, runId: text(query.runId, 128) }
  if (!context.externalSessionId) throw new Error('session_required')
  if (query.before !== undefined && (!Number.isSafeInteger(query.before) || Number(query.before) < 0)) throw new Error('invalid_request')
  if (query.byteChunks !== undefined && query.byteChunks !== true) throw new Error('invalid_request')
  let chunk: { id: string; offset: number } | undefined
  if (query.chunk !== undefined) {
    const input = object(query.chunk)
    if (query.byteChunks !== true || !Number.isSafeInteger(input.offset) || Number(input.offset) <= 0 || Number(input.offset) >= DESKTOP_HISTORY_MAX_BYTES) throw new Error('invalid_request')
    chunk = { id: text(input.id, 128), offset: input.offset as number }
  }
  return {
    kind: 'history', context,
    ...(query.before === undefined ? {} : { before: query.before as number }),
    ...(query.snapshot === undefined ? {} : { snapshot: text(query.snapshot, 128) }),
    ...(query.byteChunks === true ? { byteChunks: true } : {}),
    ...(chunk ? { chunk } : {})
  }
}

// This reader is injected only by the App composition using canonical run
// orchestration. It is not an alternate execution surface or a filesystem proxy.
export function createDesktopHostReader(deps: {
  userDataDir: string
  hostId(): string
  authorizeWorkspace(cwd: string): string
  getRun(runId: string): ActiveRun | null
}): (query: DesktopHostRead) => Promise<DesktopHostReadResult> {
  // Cache only immutable serialized pages, never a full session. Continuations
  // reauthorize the workspace but reuse the original stamped bytes, so archive
  // writes cannot mix snapshots or force repeated projection of a large turn.
  // Bounds: 32 MiB/page, 64 MiB/reader, four pages; 60s-idle cursors are pruned
  // on access. Expired/evicted cursors fail explicitly, never as empty history.
  // Pages beyond 32 MiB require archive/event-level paging, not larger wire frames.
  const pages = new Map<string, { key: string; bytes: Buffer; touched: number }>()
  function chunkResult(id: string, bytes: Buffer, offset: number): DesktopHostReadResult {
    return { kind: 'history_chunk', id, offset, totalBytes: bytes.length, data: bytes.subarray(offset, offset + DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
  }
  return async (query) => {
    const now = Date.now()
    for (const [id, page] of pages) if (now - page.touched >= CHUNK_IDLE_MS) pages.delete(id)
    if (query.kind === 'info') return { kind: 'info', protocol: 1, hostId: deps.hostId(), execution: 'canonical' }
    const cwd = deps.authorizeWorkspace(query.context.cwd)
    const context = { ...query.context, cwd }
    let result: DesktopHostReadResult
    if (query.kind === 'trace') {
      const run = deps.getRun(query.runId)
      if (run && (run.cwd !== cwd || run.providerId !== context.providerId ||
          (run.agentProfileId ?? '') !== (context.agentProfileId ?? '') ||
          (context.externalSessionId !== undefined && run.externalSessionId !== context.externalSessionId))) {
        throw new Error('run_context_mismatch')
      }
      result = { kind: 'trace', run }
    } else {
      const args = {
        cwd, providerId: context.providerId as ProviderId,
        sessionId: context.externalSessionId!, userDataDir: deps.userDataDir
      }
      const key = JSON.stringify({ context, before: query.before, snapshot: query.snapshot })
      if (query.chunk) {
        const page = pages.get(query.chunk.id)
        if (!page || page.key !== key || query.chunk.offset >= page.bytes.length || query.chunk.offset % DESKTOP_HISTORY_CHUNK_BYTES !== 0) throw new Error('invalid_history_chunk')
        page.touched = Date.now()
        pages.delete(query.chunk.id)
        if (query.chunk.offset + DESKTOP_HISTORY_CHUNK_BYTES < page.bytes.length) pages.set(query.chunk.id, page)
        return chunkResult(query.chunk.id, page.bytes, query.chunk.offset)
      }
      const version = await readTraceArchiveVersionAsync(args)
      if (query.snapshot !== undefined && query.snapshot !== version.version) throw new Error('history_snapshot_changed')
      const page = await readTraceArchivePageAsync(args, { limit: 2, ...(query.before === undefined ? {} : { before: query.before }) })
      const after = await readTraceArchiveVersionAsync(args)
      if (version.version !== after.version) throw new Error('history_snapshot_changed')
      // Do not hydrate host filesystem attachment paths into client-local URLs.
      // Tool bodies remain honestly bounded by the existing history projection.
      const turns = mergeSessionTurns([], page.archive, undefined, { hydrateAttachments: false })
      result = {
        kind: 'history', history: {
          turns, hasOlder: page.hasOlder, before: page.offset, snapshot: after.version,
          source: 'trace_archive', status: page.archive ? 'available' : 'unavailable',
          ...(page.archive ? {} : { reason: 'trace_archive_unavailable' })
        }
      }
    }
    // A read may await archive IO while the host removes a workspace grant.
    deps.authorizeWorkspace(cwd)
    const serialized = JSON.stringify(result)
    const size = Buffer.byteLength(serialized)
    if (size <= MAX_RESPONSE_BYTES) return result
    if (query.kind !== 'history' || result.kind !== 'history' || !query.byteChunks || size > DESKTOP_HISTORY_MAX_BYTES) throw new Error('desktop_evidence_response_too_large')
    let cachedBytes = [...pages.values()].reduce((total, page) => total + page.bytes.length, 0)
    while (pages.size >= MAX_CACHED_PAGES || cachedBytes + size > MAX_CACHED_BYTES) {
      const id = pages.keys().next().value!
      cachedBytes -= pages.get(id)!.bytes.length
      pages.delete(id)
    }
    const id = randomUUID()
    const bytes = Buffer.from(serialized)
    pages.set(id, {
      key: JSON.stringify({ context, before: query.before, snapshot: query.snapshot }),
      bytes, touched: Date.now()
    })
    return chunkResult(id, bytes, 0)
  }
}
