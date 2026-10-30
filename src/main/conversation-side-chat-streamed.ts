import { createHash } from 'node:crypto'
import type { TextSpool } from './text-spool'
import type { StreamedMessage, StreamedTurn } from './conversation-side-chat-stream'

/**
 * Turn assembly shared by the native transcript projections.
 *
 * The boundaries a native reader can prove are the same for every Provider that writes a
 * JSONL transcript: a prompt opens a turn, the assistant's visible blocks follow it, and a
 * record's blank line separates records while blocks join with nothing. Only the Provider's
 * own terminal marker settles a turn, and only the captured prefix is authoritative: a
 * settled turn is frozen, an interior turn without terminal evidence refuses the snapshot,
 * and a trailing one is a tail Scry drops.
 */

/** One assistant record's visible blocks. */
export interface AssistantPart {
  spools: TextSpool[]
}

/** The bodies of one turn, in the order they were read. */
export interface TurnBodies {
  /** A raw transcript carries no Scry run id of its own. */
  runId: string
  prompt: TextSpool
  assistant: AssistantPart[]
  stopReason?: string
  providerTurnId?: string
}

/** Assistant body as ordered chunks: records joined by a blank line, blocks by none. */
async function* assistantText(parts: readonly AssistantPart[]): AsyncGenerator<string> {
  let first = true
  for (const part of parts) {
    if (!first) yield '\n\n'
    first = false
    for (const spool of part.spools) {
      for await (const chunk of spool.read()) yield chunk
    }
  }
}

export async function assistantMessage(parts: readonly AssistantPart[]): Promise<StreamedMessage> {
  const hash = createHash('sha256')
  let bytes = 0
  let first = true
  for (const part of parts) {
    if (!first) {
      hash.update('\n\n', 'utf8')
      bytes += 2
    }
    first = false
    for (const spool of part.spools) {
      // Flushed before the size is read, so a held surrogate is part of the message.
      await spool.flush()
      bytes += spool.size
      for await (const chunk of spool.read()) hash.update(chunk, 'utf8')
    }
  }
  return { role: 'assistant', bytes, contentHash: hash.digest('hex'), text: assistantText(parts) }
}

export async function promptMessage(spool: TextSpool): Promise<StreamedMessage> {
  await spool.flush()
  const bytes = spool.size
  const contentHash = await spool.digest()
  return { role: 'user', bytes, contentHash, text: spool.read() }
}

export function allSpools(turn: TurnBodies): TextSpool[] {
  return [turn.prompt, ...turn.assistant.flatMap(part => part.spools)]
}

export interface SettleOptions {
  /** Whether a terminal marker proves the Provider finished the turn. */
  settles: (stopReason: string | undefined) => boolean
}

/** Applies the prefix rule: a settled turn is frozen, an interior unsettled one refuses. */
export async function* settleTurn(
  turn: TurnBodies,
  options: SettleOptions,
  state: { sawUnsettled: boolean },
  release: (spools: Iterable<TextSpool>) => Promise<void>
): AsyncGenerator<StreamedTurn> {
  if (!options.settles(turn.stopReason)) {
    state.sawUnsettled = true
    await release(allSpools(turn))
    return
  }
  if (state.sawUnsettled) {
    await release(allSpools(turn))
    throw new Error('原生会话前缀包含没有终止证据的轮次，不能创建侧聊')
  }
  const messages: StreamedMessage[] = [await promptMessage(turn.prompt)]
  if (turn.assistant.length > 0) messages.push(await assistantMessage(turn.assistant))
  yield {
    runId: turn.runId, status: 'unavailable', settled: true, messages,
    ...(turn.providerTurnId === undefined ? {} : { providerTurnId: turn.providerTurnId })
  }
}
