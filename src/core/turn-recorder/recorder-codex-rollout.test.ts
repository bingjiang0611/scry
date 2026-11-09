import { describe, expect, it } from 'vitest'
import { parseCodexRollout } from './recorder-codex-rollout'

const row = (type: string, payload: Record<string, unknown>, timestamp: string): string =>
  JSON.stringify({ type, timestamp, payload })

describe('Codex rollout user boundaries', () => {
  it('keeps the first prompt, records native steering, and deduplicates ID-paired representations', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-1' }, '2026-10-24T10:00:00.000Z'),
      row('event_msg', { type: 'user_message', id: 'user-1', message: 'initial prompt' }, '2026-10-24T10:00:00.010Z'),
      row('response_item', { type: 'message', id: 'user-1', role: 'user', content: [{ type: 'input_text', text: 'initial prompt' }] }, '2026-10-24T10:00:00.011Z'),
      row('response_item', { type: 'message', id: 'steer-1', role: 'user', content: [{ type: 'input_text', text: 'repeat intentionally' }] }, '2026-10-24T10:00:00.020Z'),
      row('event_msg', { type: 'user_message', id: 'steer-2', message: 'repeat intentionally' }, '2026-10-24T10:00:00.030Z'),
      row('response_item', { type: 'function_call', id: 'call-1', call_id: 'call-1', name: 'exec', arguments: '{}' }, '2026-10-24T10:00:00.040Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done' }, '2026-10-24T10:00:00.050Z')
    ].join('\n') + '\n'

    const parsed = parseCodexRollout(content, 'run-1')
    expect(parsed.turns).toHaveLength(1)
    expect(parsed.turns[0].userText).toBe('initial prompt')
    expect(parsed.turns[0].events.filter(event => event.kind === 'human' && event.stage === 'steer')).toHaveLength(2)
    expect(parsed.turns[0].events.filter(event => event.kind === 'tool' && event.stage !== 'tool_result')).toHaveLength(1)
  })
})
