import type { ParsedTranscriptTurn } from './recorder-contracts.js'
import { explicitSkillEvent, skillInjection } from './recorder-codex-calls.js'
import { stableHash } from './store.js'

export type CodexUserInputState = { seenIds: Set<string>; rootMessageId?: string }

/** Keep the root prompt fixed and append subsequent, identity-deduplicated native inputs. */
export function recordCodexUserInput(
  turn: ParsedTranscriptTurn,
  text: string,
  at: string,
  nativeId: string | undefined,
  runId: string,
  state: CodexUserInputState
): string | undefined {
  if (!text || (nativeId && state.seenIds.has(nativeId))) return
  if (nativeId) state.seenIds.add(nativeId)
  const skill = skillInjection(text)
  if (skill) {
    turn.events.push(explicitSkillEvent(skill, runId, at))
    turn.observable.skills = true
    return skill
  }
  if (/^\s*(?:<recommended_plugins>|# AGENTS\.md instructions|<environment_context>)/.test(text)) return
  if (!turn.userText) {
    turn.userText = text
    state.rootMessageId = nativeId
    return
  }
  if (nativeId && nativeId === state.rootMessageId) return
  const messageId = nativeId && /^[A-Za-z0-9_-]{1,80}$/.test(nativeId)
    ? nativeId
    : `codex-steer-${stableHash([turn.providerTurnId, at, nativeId ?? '', turn.events.length]).slice(0, 24)}`
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
