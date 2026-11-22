import { setTimeout as delay } from 'node:timers/promises'
import { KNOWN_SUBSCRIBE_EVENT_TYPES, parseSubscribeReply } from '../daemon-subscribe-parse'
import type { DesktopRemoteHistory } from '../../shared/desktop-remote'
import type { SubscribeKnownCursor, SubscribeRequest, SubscribeSessionRef } from '../../shared/orchestration-subscribe'
import { assembleByteChunks } from './desktop-byte-chunks'
import { fail, record } from './desktop-client-validation'

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
