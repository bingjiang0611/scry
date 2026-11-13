import { describe, expect, it } from 'vitest'
import type { ConversationPage } from '@shared/conversation-api'
import type { ActiveRun } from '@shared/trace'
import { missingConversationTurns, projectConversationTurns } from './conversation-turn-projection'

const pageTurn = (runId: string, extra: Partial<ConversationPage['turns'][number]> = {}): ConversationPage['turns'][number] => ({
  ordinal: 1, runId, bindingId: 'binding', providerId: 'codex', commandId: `command-${runId}`,
  delivery: { status: 'pending' }, ...extra
}) as ConversationPage['turns'][number]

describe('conversation timeline projection', () => {
  it('shows a running turn whose live stream has not answered as running, with the submitted prompt', () => {
    const turns = [pageTurn('run-1', { unavailableReason: '历史正文需从其权威归档读取' })]
    const projected = projectConversationTurns({ pageTurns: turns, activeRunId: 'run-1', live: undefined, cwd: '/repo',
      pending: { commandId: 'command-run-1', prompt: 'side chat question' } })
    // Before this, the turn was dropped and the side chat read as "send result not confirmed"
    // with "history must be read from its archive" for as long as the run lasted.
    expect(projected).toEqual([{ runId: 'run-1', ordinal: 1, providerId: 'codex', cwd: '/repo',
      userText: 'side chat question', items: [], done: false }])
    expect(missingConversationTurns(turns, 'run-1', undefined)).toEqual([])
  })

  it('never lends another submission’s prompt to the running turn', () => {
    const projected = projectConversationTurns({ pageTurns: [pageTurn('run-1')], activeRunId: 'run-1', live: undefined,
      cwd: '/repo', pending: { commandId: 'another-command', prompt: 'not this one' } })
    expect(projected[0]?.userText).toBe('')
  })

  it('uses the live stream for the running turn and the archive for settled ones', () => {
    const live = { runId: 'run-2', userText: 'live question', items: [], done: false } as unknown as ActiveRun
    const settled = { runId: 'run-1', userText: 'old question', items: [], done: true }
    const turns = [pageTurn('run-1', { history: settled } as never), pageTurn('run-2', { ordinal: 2 })]
    const projected = projectConversationTurns({ pageTurns: turns, activeRunId: 'run-2', live, cwd: '/repo' })
    expect(projected.map(turn => [turn.runId, turn.userText, turn.done])).toEqual([
      ['run-1', 'old question', true], ['run-2', 'live question', false]])
  })

  it('still reports a settled turn without a record as missing, and does not invent it', () => {
    const turns = [pageTurn('run-1', { delivery: { status: 'unknown', reason: 'no receipt' } } as never)]
    expect(projectConversationTurns({ pageTurns: turns, activeRunId: undefined, live: undefined, cwd: '/repo' })).toEqual([])
    expect(missingConversationTurns(turns, undefined, undefined).map(turn => turn.runId)).toEqual(['run-1'])
  })
})
