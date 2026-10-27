import type { AgentInputAttachment } from '../../shared/runtime'
import type { ActiveRun } from '../../shared/trace'
import type { DesktopRemoteContext, DesktopRemoteTraceRead, DesktopTraceChange, DesktopTraceCursor } from '../../shared/desktop-remote'
import { DesktopRemoteClientHistory } from './desktop-client-history'
import { context, fail, record, text, validRunId, MAX_ITEMS, validateTraceEvent } from './desktop-client-validation'
import { DESKTOP_ATTACHMENT_MAX_COUNT } from './desktop-attachments'

export abstract class DesktopRemoteClientTrace extends DesktopRemoteClientHistory {
  async trace(connectionIdValue: string, value: DesktopRemoteContext, runId: string, knownAttachmentCount?: number): Promise<ActiveRun | null> {
    if (!validRunId(runId)) fail('invalid_run_id')
    if (knownAttachmentCount !== undefined && (!Number.isSafeInteger(knownAttachmentCount) || knownAttachmentCount < 0 || knownAttachmentCount > DESKTOP_ATTACHMENT_MAX_COUNT)) fail('invalid_request')
    const result = await this.readTrace(connectionIdValue, { kind: 'trace', context: context(value), runId, images: true, byteChunks: true })
    if (result.kind !== 'trace') fail('invalid_trace_response')
    return this.traceSnapshot(connectionIdValue, value, runId, result, knownAttachmentCount)
  }

  // Delta reads only after the connected host declared `traceDelta: 1`. Older
  // hosts, and a host that ignores the `delta` field, answer with the full
  // snapshot shape; that is returned without a cursor so the caller keeps
  // reading snapshots instead of failing or showing an empty run.
  async traceDelta(connectionIdValue: string, value: DesktopRemoteContext, runId: string, after?: DesktopTraceCursor, knownAttachmentCount?: number): Promise<DesktopRemoteTraceRead> {
    if (!validRunId(runId)) fail('invalid_run_id')
    if (knownAttachmentCount !== undefined && (!Number.isSafeInteger(knownAttachmentCount) || knownAttachmentCount < 0 || knownAttachmentCount > DESKTOP_ATTACHMENT_MAX_COUNT)) fail('invalid_request')
    if (after !== undefined && (!record(after) || !text(after.revision, 128) || !Number.isSafeInteger(after.count) || after.count < 0 || after.count > MAX_ITEMS)) fail('invalid_request')
    const delta = this.active.get(connectionIdValue)?.traceDelta === 1
    const result = await this.readTrace(connectionIdValue, { kind: 'trace', context: context(value), runId, images: true, byteChunks: true,
      ...(delta ? { delta: after ? { after: { revision: after.revision, count: after.count } } : {} } : {}) })
    if (result.kind === 'trace') {
      const run = await this.traceSnapshot(connectionIdValue, value, runId, result, knownAttachmentCount)
      if (result.revision === undefined || run === null) return { kind: 'snapshot', run }
      if (!delta || !text(result.revision, 128) || result.reset !== true) fail('invalid_trace_response')
      return { kind: 'snapshot', run, cursor: { revision: result.revision, count: run.items.length } }
    }
    if (result.kind !== 'trace_delta' || !after || !record(result.run) || result.run.items !== undefined || !this.traceRunMeta(result.run) ||
        !text(result.base, 128) || !text(result.revision, 128) || !Number.isSafeInteger(result.count) || Number(result.count) < 0 || Number(result.count) > MAX_ITEMS ||
        !Array.isArray(result.changes) || result.changes.length > Number(result.count)) fail('invalid_trace_response')
    const count = result.count as number
    const changes = result.changes.map((change): DesktopTraceChange => {
      if (!record(change) || !Number.isSafeInteger(change.index) || Number(change.index) < 0 || Number(change.index) >= count) fail('invalid_trace_response')
      return { index: change.index as number, item: validateTraceEvent(change.item) }
    })
    const attachments = await this.traceAttachments(connectionIdValue, value, runId, result.imageCount, knownAttachmentCount)
    return { kind: 'delta', run: { ...result.run, ...(attachments ? { attachments } : {}) } as unknown as Omit<ActiveRun, 'items'>, base: result.base, cursor: { revision: result.revision, count }, changes }
  }

  protected async traceSnapshot(connectionIdValue: string, value: DesktopRemoteContext, runId: string, result: Record<string, unknown>, knownAttachmentCount?: number): Promise<ActiveRun | null> {
    if (result.run !== null && !record(result.run)) fail('invalid_trace_response')
    if (result.run === null) return null
    const run = result.run
    if (!this.traceRunMeta(run) || !Array.isArray(run.items) || run.items.length > MAX_ITEMS) fail('invalid_trace_response')
    const attachments = await this.traceAttachments(connectionIdValue, value, runId, result.imageCount, knownAttachmentCount)
    return { ...run, ...(attachments ? { attachments } : {}), runId: run.runId, userText: run.userText, done: run.done, items: run.items.map((item) => validateTraceEvent(item)) } as unknown as ActiveRun
  }
  protected traceRunMeta(run: Record<string, unknown>): boolean {
    return text(run.runId, 128) && typeof run.userText === 'string' && run.userText.length <= 128_000 && typeof run.done === 'boolean'
  }
  // Images are re-read only when the host count differs from what the caller
  // already shows (or is zero); undefined means "keep the attachments you have".
  protected traceAttachments(connectionIdValue: string, value: DesktopRemoteContext, runId: string, imageCount: unknown, knownAttachmentCount?: number): Promise<AgentInputAttachment[] | undefined> {
    return imageCount !== undefined && (imageCount !== knownAttachmentCount || imageCount === 0)
      ? this.readImages(connectionIdValue, value, runId, imageCount) : Promise.resolve(undefined)
  }

  // Older hosts ignore byteChunks and keep their previous bounded response behavior.
}
