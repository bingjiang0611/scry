import type { ParsedTurn } from './normalize.js'

export function transcriptIdentityContradictory(line: Record<string, unknown>): boolean {
  const pairs: Array<[string, string]> = [['prompt_id', 'promptId'], ['request_set_id', 'requestSetId']]
  return pairs.some(([snake, camel]) => {
    const snakeValue = typeof line[snake] === 'string' ? line[snake] as string : undefined
    const camelValue = typeof line[camel] === 'string' ? line[camel] as string : undefined
    return !!snakeValue && !!camelValue && snakeValue !== camelValue
  })
}

export function transcriptIdentityEligible(line: Record<string, unknown>, allowMeta = false): boolean {
  return line.parent_tool_use_id == null && (allowMeta || line.isMeta !== true) && line.isSynthetic !== true &&
    line.isSidechain !== true && line.isReplay !== true && !line.forkedFrom
}

export function transcriptProviderTurnId(line: Record<string, unknown>): string | undefined {
  for (const key of ['promptId', 'prompt_id', 'turnId', 'turn_id']) {
    if (typeof line[key] === 'string' && line[key]) return line[key]
  }
  return undefined
}

export function transcriptRequestSetId(line: Record<string, unknown>): string | undefined {
  for (const key of ['requestSetId', 'request_set_id']) {
    if (typeof line[key] === 'string' && line[key]) return line[key]
  }
  return undefined
}

function isCommandWrapper(text: string): boolean {
  return /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>[\s\S]*?<command-args>\s*[\s\S]*?\s*<\/command-args>/i.test(text)
}

export function mergeInjectedTranscriptIdentity(cur: ParsedTurn, line: Record<string, unknown>): void {
  // Only a meta skill line in a command-wrapper turn may carry its native identity.
  // A pasted skill header is display evidence, not a turn identity source.
  if (line.isMeta !== true || !isCommandWrapper(cur.userText) || !transcriptIdentityEligible(line, true)) return
  const providerTurnId = transcriptProviderTurnId(line)
  if (providerTurnId) {
    if (cur.providerTurnId && cur.providerTurnId !== providerTurnId) cur.identityContradictory = true
    else if (!cur.providerTurnId) cur.providerTurnId = providerTurnId
  }
  const requestSetId = transcriptRequestSetId(line)
  if (requestSetId) {
    if (cur.requestSetId && cur.requestSetId !== requestSetId) cur.identityContradictory = true
    else if (!cur.requestSetId) cur.requestSetId = requestSetId
  }
  if (transcriptIdentityContradictory(line)) cur.identityContradictory = true
}

