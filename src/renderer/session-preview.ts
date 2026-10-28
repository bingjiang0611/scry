import type { ParsedTurn } from './env'
import type { OlderSessionPage } from './hooks/useAgentSession-helpers'

export function sessionPreviewPage(sessionId: string, previewText?: string, previewRunId?: string): OlderSessionPage | undefined {
  const userText = previewText?.trim()
  if (!userText) return undefined
  const turn: ParsedTurn = {
    runId: previewRunId ?? `session-preview:${sessionId}`,
    userText,
    items: [],
    done: true
  }
  return {
    turns: [turn],
    offset: 0,
    totalTurns: 1,
    hasOlder: false,
    sourceComplete: false,
    completeness: 'partial'
  }
}
