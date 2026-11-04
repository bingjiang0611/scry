import { extractUserText } from '../normalize'
import type { HistoricalInput } from './historical-input'

export interface QoderTranscriptMessage {
  uuid?: string
  type?: string
  message?: unknown
}

/**
 * Settles the managed input receipt from the native transcript.
 *
 * Input acceptance is separate from the turn outcome: a native `user` message with
 * the same run-owned UUID and the exact submitted text proves the Provider received
 * this input even when the turn later failed or was interrupted. The outcome stays
 * whatever the run reported; this function never relabels a failed turn as success.
 * A missing UUID, another session or different text proves nothing and stays
 * `unknown`, never `not_sent`. The resumed-session check lives in HistoricalInput.
 */
export function settleQoderInputReceipt(input: {
  history: HistoricalInput
  messages: readonly QoderTranscriptMessage[]
  submittedUserUuid: string
  outgoingText: string
  externalSessionId: string
  providerTurnId?: string
}): void {
  const persisted = input.messages.find((message) => message.uuid === input.submittedUserUuid)
  const persistedText = extractUserText((persisted?.message as { content?: unknown } | undefined)?.content)
  if (persisted?.type === 'user' && persistedText === input.outgoingText) {
    input.history.accepted(input.externalSessionId, 'qoder_transcript_user_uuid', input.providerTurnId)
  } else {
    input.history.unverified('Qoder 原生 transcript 中未找到与本次投递一致的 user 消息')
  }
}
