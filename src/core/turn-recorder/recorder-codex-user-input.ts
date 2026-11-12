import type { ParsedTranscriptTurn } from './recorder-contracts.js'
import { explicitSkillEvent, skillInjection } from './recorder-codex-calls.js'
import { stableHash } from './store.js'

export type CodexUserInputSource = 'event_msg_user_message' | 'response_item_user'

const CONTEXT_INPUT = /^\s*(?:<recommended_plugins>|# AGENTS\.md instructions|<environment_context>)/

export function isCodexAppContextInput(text: string): boolean {
  // Stop at the first matching close tag: a second packet or surrounding prose
  // is not a single app envelope. Payload JSON and part counts are opaque.
  const packet = /^\s*<(external_codex_apps_[A-Za-z0-9_.:-]+)>[\s\S]*?<\/\1>/.exec(text)
  return !!packet && text.slice(packet[0].length).trim() === ''
}

function isContextInput(text: string): boolean {
  return CONTEXT_INPUT.test(text) || isCodexAppContextInput(text)
}

type PendingCodexUserInput = {
  text: string
  at: string
  nativeId?: string
  source: CodexUserInputSource
  sequence: number
}

export type CodexUserInputState = {
  seenIds: Set<string>
  pendingInputs: PendingCodexUserInput[]
}

function appendCodexUserInput(
  turn: ParsedTranscriptTurn,
  input: PendingCodexUserInput,
  runId: string,
  state: CodexUserInputState
): string | undefined {
  const { text, at, nativeId, sequence } = input
  if (!text || (nativeId && state.seenIds.has(nativeId))) return
  if (nativeId) state.seenIds.add(nativeId)
  const skill = skillInjection(text)
  if (skill) {
    turn.events.push(explicitSkillEvent(skill, runId, at))
    turn.observable.skills = true
    return skill
  }
  if (isContextInput(text)) return
  if (!turn.userText) {
    turn.userText = text
    return
  }
  const messageId = nativeId && /^[A-Za-z0-9_-]{1,80}$/.test(nativeId)
    ? nativeId
    : `codex-steer-${stableHash([turn.providerTurnId, at, nativeId ?? '', sequence]).slice(0, 24)}`
  turn.events.push({
    id: `codex-steer-${stableHash([turn.providerTurnId, messageId]).slice(0, 16)}`,
    ts: at,
    runId,
    kind: 'human',
    stage: 'steer',
    steer: {
      messageId,
      prompt: text,
      attachments: [],
      status: 'accepted',
      ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {})
    },
    runtimeMetadata: {
      source: 'codex_native_user_message',
      ...(nativeId ? { nativeMessageId: nativeId } : {})
    }
  })
}

export function recordCodexUserInput(
  text: string,
  at: string,
  nativeId: string | undefined,
  state: CodexUserInputState,
  source: CodexUserInputSource
): void {
  if (text) state.pendingInputs.push({ text, at, nativeId, source, sequence: state.pendingInputs.length })
}

export function flushCodexUserInputs(
  turn: ParsedTranscriptTurn,
  runId: string,
  state: CodexUserInputState
): string | undefined {
  const pending = state.pendingInputs
  state.pendingInputs = []
  // Codex persists canonical ResponseItems before deriving legacy user_message
  // notifications; steering may have only the ResponseItem. Select the canonical
  // human-input stream, not skill/context injections, without text/clock/count pairing.
  // Producer: openai/codex rust-v0.62.0, record_input_and_rollout_usermsg.
  const conversationInputs = pending.filter(input => input.source === 'response_item_user')
  const hasConversationInput = conversationInputs.some(input => !isContextInput(input.text) && !skillInjection(input.text))
  const inputs = hasConversationInput ? conversationInputs : pending
  let skill: string | undefined
  for (const input of inputs) {
    const injected = appendCodexUserInput(turn, input, runId, state)
    if (injected) skill = injected
  }
  return skill
}
