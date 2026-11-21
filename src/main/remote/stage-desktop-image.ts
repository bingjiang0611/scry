import { attachmentSha256, DESKTOP_ATTACHMENT_CHUNK_BYTES, type DesktopAttachmentMetadata } from './desktop-attachments'
import type { AgentInputAttachment } from '../../shared/runtime'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Reference = DesktopAttachmentMetadata & { kind: 'image'; dataBase64: '' }

export function desktopImageReference(attachment: AgentInputAttachment, ids: Pick<DesktopAttachmentMetadata, 'attachmentId' | 'intentId' | 'index' | 'totalCount'>): Reference {
  const { attachmentId, intentId, index, totalCount } = ids
  return { kind: 'image', dataBase64: '', attachmentId, intentId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size ?? 0, sha256: attachmentSha256(attachment), index, totalCount }
}

export async function stageDesktopImage(request: (body: Record<string, unknown>) => Promise<unknown>, reference: Reference, attachment: AgentInputAttachment): Promise<void> {
  const { kind: _kind, dataBase64: _dataBase64, ...metadata } = reference
  const { attachmentId } = metadata
  const fail = (): never => { throw new Error('attachment_transfer_failed') }
  const started = await request({ op: 'attachmentStart', ...metadata })
  if (!record(started) || started.status !== 'ready') fail()
  const bytes = Buffer.from(attachment.dataBase64, 'base64')
  for (let offset = 0; offset < bytes.length; offset += DESKTOP_ATTACHMENT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + DESKTOP_ATTACHMENT_CHUNK_BYTES)
    const uploaded = await request({ op: 'attachmentChunk', attachmentId, offset, dataBase64: chunk.toString('base64') })
    if (!record(uploaded) || uploaded.offset !== offset + chunk.length) fail()
  }
  const response = await request({ op: 'attachmentCommit', attachmentId })
  const committed = record(response) ? response.attachment : undefined
  if (!record(committed) || Object.entries(metadata).some(([key, value]) => committed[key] !== value)) fail()
}
