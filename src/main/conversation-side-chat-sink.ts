import { SESSION_TITLE_MAX_LENGTH } from '../shared/session-title'
import type { CaptureItem, CaptureMessageMeta, CaptureSink } from './conversation-side-chat-capture'
import type { StreamedMessage } from './conversation-side-chat-stream'

/** The user-visible freeze boundary; creation re-verifies this exact turn. */
export interface RequestedBoundary {
  ordinal: number
  runId?: string
}

/** Records the first characters of a title candidate without holding the whole message. */
class TitleTap {
  private text = ''
  private done = false

  /** Only the first user prompt names the child; later text is not a title candidate. */
  take(message: StreamedMessage): StreamedMessage {
    if (this.done || message.role !== 'user') return message
    const tap = this
    const limit = SESSION_TITLE_MAX_LENGTH * 4
    tap.done = true
    return {
      ...message,
      text: (async function* (): AsyncGenerator<string> {
        for await (const chunk of message.text) {
          if (tap.text.length < limit) tap.text += chunk.slice(0, limit - tap.text.length)
          yield chunk
        }
      })()
    }
  }

  get value(): string | undefined {
    return this.text.length > 0 ? this.text : undefined
  }
}

/**
 * Feeds one source message to the sink, keeping only the title candidate.
 *
 * The message is consumed exactly once: preview measures it, creation writes it, and the
 * title tap rides the same pass instead of asking for the body again.
 */
async function consume(
  sink: CaptureSink,
  message: StreamedMessage,
  meta: CaptureMessageMeta,
  title: TitleTap
): Promise<CaptureItem> {
  return sink.append(title.take(message), meta)
}

export { TitleTap, consume }
