import { randomUUID } from 'node:crypto'
import type { AgentInputAttachment } from '../../shared/runtime'
import { readStoredAttachmentBytes } from '../attachment-store'
import { DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_MAX_COUNT } from './desktop-attachments'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES, type DesktopHostRead, type DesktopHostReadResult, type DesktopRemoteContext, type DesktopTraceCursor } from '../../shared/desktop-remote'
import type { ActiveRun } from '../../shared/trace'
import type { ProviderId } from '../../shared/provider'
import { mergeSessionTurns } from '../session-history'
import { readTraceArchivePageAsync, readTraceArchiveVersionAsync, readTraceArchiveTurnForHistory } from '../transcript-archive'
import { createTraceRevisions } from './desktop-trace-delta'

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
  if (query.kind !== 'history' && query.kind !== 'trace' && query.kind !== 'image') throw new Error('invalid_request')
  const input = object(query.context)
  const providerId = text(input.providerId, 64)
  if (!PROVIDERS.includes(providerId)) throw new Error('provider_unsupported')
  const context: DesktopRemoteContext = {
    providerId,
    cwd: text(input.cwd, 4096),
    ...(input.agentProfileId === undefined ? {} : { agentProfileId: text(input.agentProfileId, 128) }),
    ...(input.externalSessionId === undefined ? {} : { externalSessionId: text(input.externalSessionId, 256) })
  }
  if (query.images !== undefined && query.images !== true) throw new Error('invalid_request')
  if (query.historyScope !== undefined && (query.historyScope !== 'session' || query.kind === 'trace')) throw new Error('invalid_request')
  const scope = query.historyScope === 'session' ? { historyScope: 'session' as const } : {}
  if (query.kind === 'trace') {
    let delta: { after?: DesktopTraceCursor } | undefined
    if (query.delta !== undefined) {
      const value = object(query.delta)
      if (value.after === undefined) delta = {}
      else {
        const after = object(value.after)
        if (!Number.isSafeInteger(after.count) || Number(after.count) < 0) throw new Error('invalid_request')
        delta = { after: { revision: text(after.revision, 128), count: after.count as number } }
      }
    }
    return { kind: 'trace', context, runId: text(query.runId, 128), ...(query.images ? { images: true } : {}), ...(delta ? { delta } : {}) }
  }
  if (query.kind === 'image') {
    if (!Number.isSafeInteger(query.index) || Number(query.index) < 0 || Number(query.index) >= DESKTOP_ATTACHMENT_MAX_COUNT) throw new Error('invalid_request')
    let chunk: { id: string; offset: number } | undefined
    if (query.chunk !== undefined) {
      const value = object(query.chunk)
      if (!Number.isSafeInteger(value.offset) || Number(value.offset) <= 0 || Number(value.offset) >= DESKTOP_ATTACHMENT_MAX_BYTES) throw new Error('invalid_request')
      chunk = { id: text(value.id, 128), offset: value.offset as number }
    }
    return {
      kind: 'image', context, ...scope, runId: text(query.runId, 128), index: query.index as number,
      ...(query.providerTurnId === undefined ? {} : { providerTurnId: text(query.providerTurnId, 256) }),
      ...(chunk ? { chunk } : {})
    }
  }
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
    kind: 'history', context, ...scope,
    ...(query.before === undefined ? {} : { before: query.before as number }),
    ...(query.snapshot === undefined ? {} : { snapshot: text(query.snapshot, 128) }),
    ...(query.byteChunks === true ? { byteChunks: true } : {}),
    ...(query.images === true ? { images: true } : {}),
    ...(chunk ? { chunk } : {})
  }
}

// This reader is injected only by the App composition using canonical run
// orchestration. It is not an alternate execution surface or a filesystem proxy.
export function createDesktopHostReader(deps: {
  userDataDir: string
  hostId(): string
  authorizeWorkspace(cwd: string): string
  authorizeSession?(context: DesktopRemoteContext): void
  getRun(runId: string): ActiveRun | null
}): (query: DesktopHostRead) => Promise<DesktopHostReadResult> {
  // Cache only immutable serialized pages, never a full session. Continuations
  // reauthorize the workspace but reuse the original stamped bytes, so archive
  // writes cannot mix snapshots or force repeated projection of a large turn.
  // Bounds: 32 MiB/page, 64 MiB/reader, four pages; 60s-idle cursors are pruned
  // on access. Expired/evicted cursors fail explicitly, never as empty history.
  // Pages beyond 32 MiB require archive/event-level paging, not larger wire frames.
  const pages = new Map<string, { key: string; bytes: Buffer; touched: number; image?: Pick<AgentInputAttachment, 'name' | 'mimeType'> }>()
  const traceRevisions = createTraceRevisions()
  function chunkResult(id: string, bytes: Buffer, offset: number): DesktopHostReadResult {
    return { kind: 'history_chunk', id, offset, totalBytes: bytes.length, data: bytes.subarray(offset, offset + DESKTOP_HISTORY_CHUNK_BYTES).toString('base64') }
  }
  function cache(key: string, bytes: Buffer, image?: Pick<AgentInputAttachment, 'name' | 'mimeType'>): string {
    let cachedBytes = [...pages.values()].reduce((total, page) => total + page.bytes.length, 0)
    while (pages.size >= MAX_CACHED_PAGES || cachedBytes + bytes.length > MAX_CACHED_BYTES) {
      const id = pages.keys().next().value!
      cachedBytes -= pages.get(id)!.bytes.length
      pages.delete(id)
    }
    const id = randomUUID()
    pages.set(id, { key, bytes, touched: Date.now(), ...(image ? { image } : {}) })
    return id
  }
  return async (query) => {
    const now = Date.now()
    for (const [id, page] of pages) if (now - page.touched >= CHUNK_IDLE_MS) pages.delete(id)
    traceRevisions.sweep(now, CHUNK_IDLE_MS)
    if (query.kind === 'info') return { kind: 'info', protocol: 1, hostId: deps.hostId(), execution: 'canonical', traceDelta: 1 }
    const cwd = deps.authorizeWorkspace(query.context.cwd)
    const context = { ...query.context, cwd }
    const sessionScope = query.kind !== 'trace' && query.historyScope === 'session'
    if (sessionScope) {
      if (!deps.authorizeSession || !context.externalSessionId) throw new Error('history_session_authority_unavailable')
      deps.authorizeSession(context)
    }
    let result: DesktopHostReadResult
    if (query.kind === 'image') {
      const key = JSON.stringify({ kind: 'image', context, sessionScope, runId: query.runId, providerTurnId: query.providerTurnId, index: query.index })
      let id = query.chunk?.id
      const offset = query.chunk?.offset ?? 0
      if (!id) {
        // Display images come from the exact bound archive turn, not whichever
        // runtime happens to retain that run id. Live trace reads stay scoped.
        const run = sessionScope ? null : deps.getRun(query.runId)
        if (run && (run.cwd !== cwd || run.providerId !== context.providerId || (run.agentProfileId ?? '') !== (context.agentProfileId ?? '') || (context.externalSessionId !== undefined && run.externalSessionId !== context.externalSessionId))) throw new Error('run_context_mismatch')
        const archived = !run && context.externalSessionId ? await readTraceArchiveTurnForHistory({
          cwd, sessionId: context.externalSessionId, userDataDir: deps.userDataDir, providerId: context.providerId as ProviderId,
          runId: query.runId, providerTurnId: query.providerTurnId, maxBytes: DESKTOP_HISTORY_MAX_BYTES
        }) : undefined
        if (archived && !sessionScope && archived.turn.agentProfileId !== (context.agentProfileId ?? null)) throw new Error('history_profile_unavailable')
        const attachment = (run?.attachments ?? archived?.turn.attachments)?.[query.index]
        if (!attachment) throw new Error('attachment_unavailable')
        const bytes = await readStoredAttachmentBytes(deps.userDataDir, query.runId, attachment, DESKTOP_ATTACHMENT_MAX_BYTES)
        deps.authorizeWorkspace(cwd)
        id = cache(key, bytes, { name: attachment.name, mimeType: attachment.mimeType })
      }
      const page = pages.get(id)
      if (!page?.image || page.key !== key || offset >= page.bytes.length || offset % DESKTOP_HISTORY_CHUNK_BYTES !== 0) throw new Error('invalid_image_chunk')
      page.touched = Date.now()
      if (offset + DESKTOP_HISTORY_CHUNK_BYTES >= page.bytes.length) pages.delete(id)
      if (sessionScope) deps.authorizeSession!(context)
      return { kind: 'image_chunk', id, offset, totalBytes: page.bytes.length, data: page.bytes.subarray(offset, offset + DESKTOP_HISTORY_CHUNK_BYTES).toString('base64'), ...page.image,
        ...(sessionScope ? { historyScope: 'session' as const } : {}) }
    }
    if (query.kind === 'trace') {
      const run = deps.getRun(query.runId)
      if (run && (run.cwd !== cwd || run.providerId !== context.providerId ||
          (run.agentProfileId ?? '') !== (context.agentProfileId ?? '') ||
          (context.externalSessionId !== undefined && run.externalSessionId !== context.externalSessionId))) {
        throw new Error('run_context_mismatch')
      }
      if (!run) traceRevisions.forget(query.runId)
      const images = query.images && run ? { imageCount: run.attachments?.length ?? 0 } : {}
      const shown = query.images && run ? { ...run, attachments: undefined } : run
      if (!query.delta || !shown) result = { kind: 'trace', run: shown, ...images }
      else {
        // Same authorization as a full read above; only the response shape differs.
        const answer = traceRevisions.observe(query.runId, shown.items, query.delta.after, now)
        const { items, ...meta } = shown
        result = answer.reset
          ? { kind: 'trace', run: shown, ...images, revision: answer.revision, reset: true }
          : { kind: 'trace_delta', run: meta, ...images, base: query.delta.after!.revision, revision: answer.revision, count: answer.count,
              changes: answer.changes.map((index) => ({ index, item: items[index] })) }
      }
    } else {
      const args = {
        cwd, providerId: context.providerId as ProviderId,
        ...(!sessionScope ? { agentProfileId: context.agentProfileId ?? null } : {}),
        sessionId: context.externalSessionId!, userDataDir: deps.userDataDir
      }
      const key = JSON.stringify({ context, sessionScope, before: query.before, snapshot: query.snapshot })
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
      const page = await readTraceArchivePageAsync(args, {
        ...(sessionScope ? { requireComplete: true } : { agentProfileId: args.agentProfileId }),
        limit: 2, ...(query.before === undefined ? {} : { before: query.before })
      })
      const after = await readTraceArchiveVersionAsync(args)
      if (version.version !== after.version) throw new Error('history_snapshot_changed')
      // Do not hydrate host filesystem attachment paths into client-local URLs.
      // Tool bodies remain honestly bounded by the existing history projection.
      const turns = mergeSessionTurns([], page.archive, undefined, { hydrateAttachments: false })
      result = {
        kind: 'history', history: {
          ...(sessionScope ? { historyScope: 'session' as const } : {}),
          ...(query.images ? { imageCounts: Object.fromEntries((page.archive?.turns ?? []).filter(turn => turn.attachments?.length).map(turn => [turn.runId, turn.attachments!.length])) } : {}),
          turns, hasOlder: page.hasOlder, before: page.offset, snapshot: after.version,
          source: 'trace_archive', status: page.archive ? 'available' : 'unavailable',
          ...(page.archive ? {} : { reason: 'trace_archive_unavailable' })
        }
      }
    }
    // A read may await archive IO while the host removes a workspace grant.
    deps.authorizeWorkspace(cwd)
    if (sessionScope) deps.authorizeSession!(context)
    const serialized = JSON.stringify(result)
    const size = Buffer.byteLength(serialized)
    if (size <= MAX_RESPONSE_BYTES) return result
    if (query.kind !== 'history' || result.kind !== 'history' || !query.byteChunks || size > DESKTOP_HISTORY_MAX_BYTES) throw new Error('desktop_evidence_response_too_large')
    const bytes = Buffer.from(serialized)
    const id = cache(JSON.stringify({ context, sessionScope, before: query.before, snapshot: query.snapshot }), bytes)
    return chunkResult(id, bytes, 0)
  }
}
