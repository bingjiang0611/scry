import type { ProviderId } from '../shared/provider'
import { sideChatSnapshotRunId } from '../shared/conversation'
import type { SideChatSnapshotWriter } from './conversation-side-chat-manifest'
import type { StreamedMessage } from './conversation-side-chat-stream'
import { HandoffTextBytes, messageBaseBytes } from './conversation-side-chat-inline'

/**
 * The two ways one frozen message is consumed, with the same facts from both.
 *
 * Preview measures a message and never keeps it; creation writes it straight into the
 * sealed manifest. Both read the text exactly once, as a stream, so neither the item
 * metadata nor the handoff cost depends on holding the body.
 */
export interface CaptureItem {
  role: 'user' | 'assistant'
  sourceRunId: string
  sourceOrdinal: number
  providerId: ProviderId
  contentHash: string
  /** Exact UTF-8 bytes of the message text. */
  bytes: number
  /** Exact bytes this message adds to the first-send handoff, including both escapes. */
  inlineBytes: number
}

export interface CaptureMessageMeta {
  role: 'user' | 'assistant'
  sourceRunId: string
  sourceOrdinal: number
  providerId: ProviderId
  status: string
  delivery: string
  nativeSessionId?: string
  providerTurnId?: string
}

export interface CaptureSink {
  /** Consumes the message exactly once and returns the facts the record will claim. */
  append(message: StreamedMessage, meta: CaptureMessageMeta): Promise<CaptureItem>
}

/** Constant part of the handoff cost: this message's own metadata, without its text. */
function inlineBase(meta: CaptureMessageMeta, contentHash: string): number {
  return messageBaseBytes({
    ref: { runId: meta.sourceRunId, itemId: meta.role, contentHash },
    providerId: meta.providerId,
    ...(meta.nativeSessionId === undefined ? {} : { nativeSessionId: meta.nativeSessionId }),
    ...(meta.providerTurnId === undefined ? {} : { providerTurnId: meta.providerTurnId }),
    ordinal: meta.sourceOrdinal,
    role: meta.role,
    status: meta.status,
    delivery: meta.delivery
  })
}

function item(meta: CaptureMessageMeta, contentHash: string, bytes: number, escapedBytes: number): CaptureItem {
  return {
    role: meta.role, sourceRunId: meta.sourceRunId, sourceOrdinal: meta.sourceOrdinal, providerId: meta.providerId,
    contentHash, bytes, inlineBytes: inlineBase(meta, contentHash) + escapedBytes
  }
}

/** Read-only pass: exact facts, no persisted body. */
export function measureSink(): CaptureSink {
  return {
    async append(message, meta) {
      const escaped = new HandoffTextBytes()
      let bytes = 0
      for await (const chunk of message.text) {
        escaped.add(chunk)
        bytes += Buffer.byteLength(chunk, 'utf8')
      }
      return item(meta, message.contentHash, bytes, escaped.total())
    }
  }
}

/** Creation pass: the same facts, produced while the body is written to the manifest. */
export function sealSink(writer: SideChatSnapshotWriter, snapshotId: string): CaptureSink {
  let index = 0
  return {
    async append(message, meta) {
      const escaped = new HandoffTextBytes()
      let bytes = 0
      const counted = (async function* (): AsyncGenerator<string> {
        for await (const chunk of message.text) {
          escaped.add(chunk)
          bytes += Buffer.byteLength(chunk, 'utf8')
          yield chunk
        }
      })()
      await writer.appendMessage({
        ref: { runId: sideChatSnapshotRunId(snapshotId, index), itemId: meta.role, contentHash: message.contentHash },
        sourceOrdinal: meta.sourceOrdinal,
        providerId: meta.providerId,
        role: meta.role,
        status: meta.status,
        delivery: meta.delivery,
        ...(meta.nativeSessionId === undefined ? {} : { nativeSessionId: meta.nativeSessionId }),
        ...(meta.providerTurnId === undefined ? {} : { providerTurnId: meta.providerTurnId })
      }, counted)
      index += 1
      return item(meta, message.contentHash, bytes, escaped.total())
    }
  }
}
