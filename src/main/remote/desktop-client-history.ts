import { setTimeout as delay } from 'node:timers/promises'
import { KNOWN_SUBSCRIBE_EVENT_TYPES, parseSubscribeReply } from '../daemon-subscribe-parse'
import type { SubscribeKnownCursor, SubscribeRequest, SubscribeSessionRef } from '../../shared/orchestration-subscribe'
import type { AgentInputAttachment } from '../../shared/runtime'
import { isSupportedImageMimeType } from '../../shared/runtime'
import type { DesktopHostRead, DesktopRemoteContext, DesktopRemoteHistory } from '../../shared/desktop-remote'
import { DESKTOP_HISTORY_CHUNK_BYTES } from '../../shared/desktop-remote'
import { assembleByteChunks } from './desktop-byte-chunks'
import { DesktopRemoteClientCatalog } from './desktop-client-catalog'
import { context, fail, record, text, uuid, MAX_ITEMS, validateTurn } from './desktop-client-validation'
import { DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES } from './desktop-attachments'

export abstract class DesktopRemoteClientHistory extends DesktopRemoteClientCatalog {
  async history(connectionIdValue: string, value: DesktopRemoteContext, before?: number, snapshot?: string): Promise<DesktopRemoteHistory> {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0) || snapshot !== undefined && !text(snapshot, 256)) fail('invalid_history_cursor')
    const scope = context(value)
    if (before === undefined && snapshot === undefined) {
      const detail = await this.watchDetail(connectionIdValue, scope)
      if (detail?.firstPage) return this.decodeHistory(connectionIdValue, scope, detail.firstPage)
    }
    const query: Extract<DesktopHostRead, { kind: 'history' }> = { kind: 'history', historyScope: 'session', context: scope, byteChunks: true, images: true, ...(before === undefined ? {} : { before }), ...(snapshot === undefined ? {} : { snapshot }) }
    let result = await this.desktop(connectionIdValue, query)
    if (result.kind === 'history_chunk') result = await this.assembleChunks(connectionIdValue, query, result, 'invalid_history_response')
    if (result.kind !== 'history') fail('invalid_history_response')
    return this.decodeHistory(connectionIdValue, scope, result.history)
  }

  override async setViewedSession(id: string, value: DesktopRemoteContext | null): Promise<void> {
    await super.setViewedSession(id, value)
    if (value === null) {
      this.detailSubscriptions.get(id)?.close()
      this.detailSubscriptions.delete(id)
    } else if (this.active.get(id)?.subscribe === 1) {
      await this.watchDetail(id, context(value))
    }
  }

  private async watchDetail(id: string, scope: DesktopRemoteContext): Promise<DesktopDetailSubscription | undefined> {
    const status = await this.statusSubscription(id)
    if (!status || !scope.externalSessionId) return undefined
    const session = status.sessions().find(item => item.cwd === scope.cwd && item.providerId === scope.providerId &&
      item.agentProfileId === scope.agentProfileId && item.externalSessionId === scope.externalSessionId)
    if (!session) return undefined
    const item = this.connection(await this.state(), id)
    const reference = { sessionKey: session.sessionId, ...scope }
    const old = this.detailSubscriptions.get(id)
    if (old?.matches(reference)) { await old.open(); return old }
    old?.close()
    const watch = new DesktopDetailSubscription({
      hostId: item.hostId,
      session: reference,
      read: (request, signal) => this.requestForConnection(id, { op: 'subscribe', ...request }, undefined, signal),
      changed: () => this.publishSubscription?.({ connectionId: id, history: true })
    })
    this.detailSubscriptions.set(id, watch)
    try { await watch.open() } catch (error) {
      if (this.detailSubscriptions.get(id) === watch) this.detailSubscriptions.delete(id)
      watch.close()
      throw error
    }
    return watch
  }

  private async decodeHistory(connectionIdValue: string, value: DesktopRemoteContext, raw: unknown): Promise<DesktopRemoteHistory> {
    if (!record(raw) || !Array.isArray(raw.turns) || typeof raw.hasOlder !== 'boolean' || raw.source !== 'trace_archive' || !['available', 'unavailable'].includes(String(raw.status))) fail('invalid_history_response')
    if (raw.historyScope !== 'session') fail('history_scope_unverified')
    if (raw.turns.length > MAX_ITEMS) fail('history_too_large')
    const turns = raw.turns.map((item) => validateTurn(item))
    if (raw.imageCounts !== undefined) {
      if (!record(raw.imageCounts)) fail('invalid_history_response')
      let imageBytes = 0
      for (const turn of turns) {
        const count = turn.runId ? raw.imageCounts[turn.runId] : undefined
        if (count === undefined) continue
        turn.attachments = await this.readImages(connectionIdValue, value, turn.runId!, count, turn.providerTurnId, 'session')
        imageBytes += turn.attachments.reduce((sum, image) => sum + (image.size ?? 0), 0)
        if (imageBytes > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES * 2) fail('history_images_too_large')
      }
    }
    return { historyScope: 'session', turns, hasOlder: raw.hasOlder, ...(Number.isSafeInteger(raw.before) ? { before: raw.before as number } : {}), ...(text(raw.snapshot, 256) ? { snapshot: raw.snapshot } : {}), source: 'trace_archive', status: raw.status as DesktopRemoteHistory['status'], ...(text(raw.reason, 512) ? { reason: raw.reason } : {}) }
  }
  protected async readTrace(connectionIdValue: string, query: Extract<DesktopHostRead, { kind: 'trace' }>): Promise<Record<string, unknown>> {
    const result = await this.desktop(connectionIdValue, query)
    return result.kind === 'history_chunk' ? this.assembleChunks(connectionIdValue, query, result, 'invalid_trace_response') : result
  }

  protected async assembleChunks(
    connectionIdValue: string,
    query: Extract<DesktopHostRead, { kind: 'history' | 'trace' }>,
    first: Record<string, unknown>,
    error: 'invalid_history_response' | 'invalid_trace_response'
  ): Promise<Record<string, unknown>> {
    // The same page validation the App's own daemon trace read uses.
    return assembleByteChunks(first, (chunk) => this.desktop(connectionIdValue, { ...query, chunk }), () => fail(error))
  }

  protected async readImages(id: string, value: DesktopRemoteContext, runId: string, count: unknown, providerTurnId?: string, historyScope?: 'session'): Promise<AgentInputAttachment[]> {
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > DESKTOP_ATTACHMENT_MAX_COUNT) fail('invalid_image_response')
    const images: AgentInputAttachment[] = []
    let total = 0
    for (let index = 0; index < Number(count); index++) {
      const query = { kind: 'image' as const, context: context(value), runId, index, ...(providerTurnId === undefined ? {} : { providerTurnId }), ...(historyScope ? { historyScope } : {}) }
      let response = await this.desktop(id, query)
      const { id: imageId, totalBytes, name, mimeType } = response
      if (response.kind !== 'image_chunk' || !uuid(imageId) || !text(name, 160) || !isSupportedImageMimeType(String(mimeType)) || !Number.isSafeInteger(totalBytes) || Number(totalBytes) <= 0 || Number(totalBytes) > DESKTOP_ATTACHMENT_MAX_BYTES) fail('invalid_image_response')
      total += Number(totalBytes)
      if (total > DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES) fail('images_too_large')
      const bytes = Buffer.alloc(Number(totalBytes))
      let offset = 0
      while (offset < bytes.length) {
        const length = Math.min(DESKTOP_HISTORY_CHUNK_BYTES, bytes.length - offset)
        if (response.kind !== 'image_chunk' || (historyScope && response.historyScope !== historyScope) || response.id !== imageId || response.offset !== offset || response.totalBytes !== totalBytes || response.name !== name || response.mimeType !== mimeType || typeof response.data !== 'string' || response.data.length !== 4 * Math.ceil(length / 3)) fail('invalid_image_response')
        const chunk = Buffer.from(response.data, 'base64')
        if (chunk.length !== length || chunk.toString('base64') !== response.data) fail('invalid_image_response')
        chunk.copy(bytes, offset)
        offset += length
        if (offset < bytes.length) response = await this.desktop(id, { ...query, chunk: { id: imageId, offset } })
      }
      images.push({ kind: 'image', name, mimeType: mimeType as AgentInputAttachment['mimeType'], dataBase64: bytes.toString('base64'), size: bytes.length })
    }
    return images
  }

}

type ReadDetail = (request: SubscribeRequest, signal: AbortSignal) => Promise<Record<string, unknown>>

/** The main process owns the watch lane and cancels it when selection changes. */
export class DesktopDetailSubscription {
  readonly #abort = new AbortController()
  readonly #hostId: string
  readonly #session: SubscribeSessionRef
  readonly #read: ReadDetail
  readonly #changed: () => void
  #observed = false
  #cursor?: SubscribeKnownCursor
  #opening?: Promise<void>
  #firstPage?: DesktopRemoteHistory

  constructor(options: { hostId: string; session: SubscribeSessionRef; read: ReadDetail; changed(): void }) {
    this.#hostId = options.hostId
    this.#session = options.session
    this.#read = options.read
    this.#changed = options.changed
  }

  matches(session: SubscribeSessionRef): boolean {
    return this.#session.sessionKey === session.sessionKey && this.#session.cwd === session.cwd &&
      this.#session.providerId === session.providerId && this.#session.agentProfileId === session.agentProfileId &&
      this.#session.externalSessionId === session.externalSessionId
  }
  get firstPage(): DesktopRemoteHistory | undefined { return this.#firstPage }
  close(): void { this.#abort.abort() }

  open(): Promise<void> {
    return this.#opening ??= this.#step().then(() => { void this.#follow() })
  }

  async #step(): Promise<void> {
    const known = this.#cursor
    const signal = this.#abort.signal
    const request: SubscribeRequest = { views: ['detail'], session: this.#session, historyOnly: true, waitMs: known ? 20_000 : 0, ...(known ? { known } : {}) }
    let raw = await this.#read(request, signal)
    if (record(raw.subscribe) && raw.subscribe.kind === 'history_chunk') {
      const assembled = await assembleByteChunks(raw.subscribe, async chunk => {
        const response = await this.#read({ ...request, chunk }, signal)
        if (!record(response.subscribe)) fail('invalid_subscribe_chunk')
        return response.subscribe
      }, () => fail('invalid_subscribe_chunk'))
      raw = { subscribe: assembled }
    }
    signal.throwIfAborted()
    const reply = parseSubscribeReply(raw, true)
    if (reply.hostId !== this.#hostId) fail('invalid_subscribe_source')
    const { hostId, logId, seq } = reply
    if (reply.mode === 'snapshot') {
      if (!reply.snapshot.detail) fail('invalid_subscribe_detail')
      const page = reply.snapshot.detail.firstPage
      this.#firstPage = page && 'kind' in page && page.kind === 'remoteHistory' ? page.history : undefined
      this.#cursor = { hostId, logId, seq }
      if (this.#observed) this.#changed()
      this.#observed = true
      return
    }
    let lastSeq = known?.seq ?? -1
    if (!known || known.logId !== logId || seq < lastSeq || reply.mode === 'events' && reply.events.some(event => {
      const invalid = !KNOWN_SUBSCRIBE_EVENT_TYPES.has(event.type) || event.seq <= lastSeq || event.seq > seq
      lastSeq = event.seq
      return invalid
    })) {
      this.#cursor = undefined
      this.#firstPage = undefined
      this.#changed()
      return
    }
    this.#cursor = { hostId, logId, seq }
    if (reply.mode === 'events' && reply.events.some(event => [
      'turn.delivery', 'run.settled', 'run.failed', 'run.cancelled', 'run.interrupted', 'session.deleted', 'session.withdrawn'
    ].includes(event.type))) {
      this.#firstPage = undefined
      this.#changed()
    }
  }

  async #follow(): Promise<void> {
    const signal = this.#abort.signal
    let retryMs = 250
    while (!signal.aborted) {
      try {
        await this.#step()
        retryMs = 250
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof Error && (error.message === 'desktop_not_connected' ||
            error.message === 'desktop_remote_device_not_authorized')) return
        try { await delay(retryMs, undefined, { signal, ref: false }) } catch { return }
        retryMs = Math.min(retryMs * 2, 5_000)
      }
    }
  }
}
