import { createHash } from 'node:crypto'
import type { Conversation, ConversationTurn } from '../shared/conversation'
import type { ProviderId } from '../shared/provider'
import { stripAttachmentMetadata } from './session-history'
import { streamTraceArchiveTurn } from './transcript-archive-capture'
import { streamTurns, type StreamedMessage } from './conversation-side-chat-stream'
import type { CaptureMessageMeta } from './conversation-side-chat-capture'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** One frozen message plus the metadata the snapshot record must claim for it. */
export interface CapturedConversationMessage {
  message: StreamedMessage
  meta: CaptureMessageMeta
}

/** Chunk size for re-emitting a buffered body; never one string per message. */
const RECHUNK = 64 * 1024

async function* rechunk(text: string): AsyncGenerator<string> {
  for (let offset = 0; offset < text.length; offset += RECHUNK) yield text.slice(offset, offset + RECHUNK)
}

/**
 * Re-emits a body unchanged while feeding the turn's combined assistant digest.
 *
 * The parent records one assistant body per turn: every assistant message joined by a
 * blank line. The digest therefore has to be taken while the sink consumes the text,
 * because the body is only ever read once.
 */
function tapped(message: StreamedMessage, separator: boolean, digest: (chunk: string) => void): StreamedMessage {
  let first = true
  const text = (async function* (): AsyncGenerator<string> {
    for await (const chunk of message.text) {
      if (first) {
        first = false
        if (separator) digest('\n\n')
      }
      digest(chunk)
      yield chunk
    }
  })()
  return { ...message, text }
}

/**
 * Streams the frozen prefix one turn at a time, proving each body against the parent's
 * recorded item hashes.
 *
 * A turn's own archive file is read by the structural projection, so tool payloads are
 * skipped and a large visible body is streamed into the snapshot instead of becoming a
 * string. The only whole body ever held is a legacy prompt that must be re-hashed after
 * attachment-metadata stripping. The combined assistant digest can only be compared once
 * the whole turn has been consumed, so that check runs when this generator advances: an
 * aborted creation never publishes the child record that would reference those bytes.
 */
export async function* capturedConversationMessages(
  userData: string,
  conversation: Pick<Conversation, 'id' | 'cwd' | 'turns' | 'bindings'>,
  prefix: readonly ConversationTurn[]
): AsyncGenerator<CapturedConversationMessage> {
  for (const turn of prefix) {
    const binding = conversation.bindings.find(candidate => candidate.id === turn.bindingId)
    if (!binding) throw new Error('来源轮次缺少原生绑定归属')
    if (!turn.archive) throw new Error('来源轮次缺少已提交的 App 归档，不能创建侧聊')
    if (turn.items.some(ref => ref.itemId !== 'user' && ref.itemId !== 'assistant')) {
      throw new Error('交接仅支持用户和助手可见文字')
    }
    const userRef = turn.items.find(ref => ref.itemId === 'user')
    const assistantRef = turn.items.find(ref => ref.itemId === 'assistant')
    const archive = turn.archive
    const source = streamTurns(userData, conversation.cwd, streamTraceArchiveTurn({
      userDataDir: userData, cwd: conversation.cwd, sessionId: archive.sessionId,
      providerId: binding.providerId
    }, { runId: turn.runId, ...(archive.providerTurnId ? { providerTurnId: archive.providerTurnId } : {}) }))
    const assistantDigest = createHash('sha256')
    let assistantCount = 0
    let turnsSeen = 0
    for await (const streamed of source) {
      if (streamed.runId !== turn.runId) throw new Error('来源归档分片与轮次不一致')
      if (!streamed.settled) throw new Error('交接源轮次尚未收敛')
      turnsSeen += 1
      for (const message of streamed.messages) {
        const meta: CaptureMessageMeta = {
          role: message.role, sourceRunId: turn.runId, sourceOrdinal: turn.ordinal,
          providerId: binding.providerId as ProviderId, status: streamed.status, delivery: 'snapshot',
          nativeSessionId: binding.nativeSessionId,
          ...(archive.providerTurnId ? { providerTurnId: archive.providerTurnId } : {})
        }
        if (message.role === 'user' && message.steerMessageId === undefined && userRef &&
          message.contentHash !== userRef.contentHash) {
          // Old refs hashed the attachment-metadata-stripped prompt; re-hash that one body.
          let raw = ''
          for await (const chunk of message.text) raw += chunk
          const legacy = stripAttachmentMetadata(raw)
          if (legacy === raw || hash(legacy) !== userRef.contentHash) {
            throw new Error('交接源正文与预览 hash 不一致，请重新预览')
          }
          yield { message: { ...message, text: rechunk(legacy), contentHash: userRef.contentHash }, meta }
          continue
        }
        if (message.role !== 'assistant') {
          yield { message, meta }
          continue
        }
        assistantCount += 1
        yield { message: tapped(message, assistantCount > 1, chunk => assistantDigest.update(chunk, 'utf8')), meta }
      }
    }
    if (turnsSeen !== 1) throw new Error('来源归档缺少该轮次，不能创建侧聊')
    if (assistantRef) {
      if (assistantCount === 0) throw new Error('交接源缺少助手正文，不能创建侧聊')
      if (assistantDigest.digest('hex') !== assistantRef.contentHash) {
        throw new Error('交接源正文与预览 hash 不一致，请重新预览')
      }
    } else if (assistantCount > 0) {
      throw new Error('交接源正文与预览 hash 不一致，请重新预览')
    }
  }
}
