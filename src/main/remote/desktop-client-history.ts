import type { AgentInputAttachment } from '../../shared/runtime'
import { isSupportedImageMimeType } from '../../shared/runtime'
import type { DesktopHostRead, DesktopRemoteContext, DesktopRemoteHistory } from '../../shared/desktop-remote'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'
import { DesktopRemoteClientCatalog } from './desktop-client-catalog'
import { context, fail, record, text, uuid, MAX_ITEMS, validateTurn } from './desktop-client-validation'
import { DESKTOP_ATTACHMENT_MAX_COUNT, DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_MAX_TOTAL_BYTES } from './desktop-attachments'

export abstract class DesktopRemoteClientHistory extends DesktopRemoteClientCatalog {
  async history(connectionIdValue: string, value: DesktopRemoteContext, before?: number, snapshot?: string): Promise<DesktopRemoteHistory> {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0) || snapshot !== undefined && !text(snapshot, 256)) fail('invalid_history_cursor')
    const query: Extract<DesktopHostRead, { kind: 'history' }> = { kind: 'history', historyScope: 'session', context: context(value), byteChunks: true, images: true, ...(before === undefined ? {} : { before }), ...(snapshot === undefined ? {} : { snapshot }) }
    let result = await this.desktop(connectionIdValue, query)
    if (result.kind === 'history_chunk') result = await this.assembleChunks(connectionIdValue, query, result, 'invalid_history_response')
    const raw = result.history
    if (result.kind !== 'history' || !record(raw) || !Array.isArray(raw.turns) || typeof raw.hasOlder !== 'boolean' || raw.source !== 'trace_archive' || !['available', 'unavailable'].includes(String(raw.status))) fail('invalid_history_response')
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
    const { id, totalBytes } = first
    if (!uuid(id) || !Number.isSafeInteger(totalBytes) || Number(totalBytes) <= 0 || Number(totalBytes) > DESKTOP_HISTORY_MAX_BYTES) fail(error)
    const bytes = Buffer.alloc(totalBytes as number)
    let result = first
    let offset = 0
    while (offset < bytes.length) {
      const length = Math.min(DESKTOP_HISTORY_CHUNK_BYTES, bytes.length - offset)
      if (result.kind !== 'history_chunk' || result.id !== id || result.totalBytes !== totalBytes || result.offset !== offset || typeof result.data !== 'string' || result.data.length !== 4 * Math.ceil(length / 3)) fail(error)
      const chunk = Buffer.from(result.data, 'base64')
      if (chunk.length !== length || chunk.toString('base64') !== result.data) fail(error)
      chunk.copy(bytes, offset)
      offset += length
      if (offset < bytes.length) result = await this.desktop(connectionIdValue, { ...query, chunk: { id, offset } })
    }
    let decoded: unknown
    try { decoded = JSON.parse(bytes.toString('utf8')) } catch { fail(error) }
    if (!record(decoded)) fail(error)
    return decoded
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
