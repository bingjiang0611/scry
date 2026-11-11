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
      row('response_item', { type: 'message', id: 'steer-2', role: 'user', content: [{ type: 'input_text', text: 'repeat intentionally' }] }, '2026-10-24T10:00:00.030Z'),
      row('response_item', { type: 'message', id: 'steer-1', role: 'user', content: [{ type: 'input_text', text: 'repeat intentionally' }] }, '2026-10-24T10:00:00.031Z'),
      row('response_item', { type: 'function_call', id: 'call-1', call_id: 'call-1', name: 'exec', arguments: '{}' }, '2026-10-24T10:00:00.040Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done' }, '2026-10-24T10:00:00.050Z')
    ].join('\n') + '\n'

    const parsed = parseCodexRollout(content, 'run-1')
    expect(parsed.turns).toHaveLength(1)
    expect(parsed.turns[0].userText).toBe('initial prompt')
    expect(parsed.turns[0].events.filter(event => event.kind === 'human' && event.stage === 'steer')).toHaveLength(2)
    expect(parsed.turns[0].events.filter(event => event.kind === 'tool' && event.stage !== 'tool_result')).toHaveLength(1)
  })

  it('uses canonical ID-less inputs despite legacy notifications interleaving tools and repeated identical prompts', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-2' }, '2026-10-24T10:01:00.000Z'),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'initial prompt' }] }, '2026-10-24T10:01:00.010Z'),
      row('turn_context', { model: 'gpt-5' }, '2026-10-24T10:01:00.011Z'),
      row('event_msg', { type: 'user_message', message: 'initial prompt' }, '2026-10-24T10:01:00.012Z'),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'repeat' }] }, '2026-10-24T10:01:00.020Z'),
      row('response_item', { type: 'function_call', call_id: 'tool-1', name: 'exec', arguments: '{}' }, '2026-10-24T10:01:00.030Z'),
      row('event_msg', { type: 'user_message', message: 'repeat' }, '2026-10-24T10:01:00.040Z'),
      row('event_msg', { type: 'user_message', message: 'repeat' }, '2026-10-24T10:01:00.050Z'),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'repeat' }] }, '2026-10-24T10:01:00.060Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-2' }, '2026-10-24T10:01:00.070Z')
    ].join('\n') + '\n'

    const parsed = parseCodexRollout(content, 'run-2')
    expect(parsed.turns[0].userText).toBe('initial prompt')
    expect(parsed.turns[0].events.filter(event => event.kind === 'human' && event.stage === 'steer').map(event => event.steer?.prompt))
      .toEqual(['repeat', 'repeat'])
  })

  it.each([
    { eventId: undefined, responseId: 'msg-only', reverse: false },
    { eventId: 'event-only', responseId: undefined, reverse: false },
    { eventId: undefined, responseId: 'msg-only', reverse: true },
    { eventId: 'event-only', responseId: undefined, reverse: true }
  ])('uses the canonical stream with one-sided IDs and reverse=$reverse, eventId=$eventId', ({ eventId, responseId, reverse }) => {
    const inputs = [
      row('event_msg', { type: 'user_message', id: eventId, message: 'display representation' }, '2026-10-24T10:02:00.010Z'),
      row('response_item', { type: 'message', id: responseId, role: 'user', content: [{ type: 'input_text', text: 'canonical prompt' }] }, '2026-10-24T10:02:00.020Z')
    ]
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-3' }, '2026-10-24T10:02:00.000Z'),
      ...(reverse ? inputs.reverse() : inputs),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-3' }, '2026-10-24T10:02:00.030Z')
    ].join('\n') + '\n'

    const parsed = parseCodexRollout(content, 'run-3')
    expect(parsed.turns[0].userText).toBe('canonical prompt')
    expect(parsed.turns[0].events.filter(event => event.kind === 'human' && event.stage === 'steer')).toHaveLength(0)
  })

  it.each([false, true])('retains repeated real inputs in an event-only legacy stream with IDs=%s', withIds => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-legacy' }, '2026-10-24T10:03:00.000Z'),
      ...['initial', 'repeat', 'repeat'].map((message, index) => row('event_msg', {
        type: 'user_message', message, ...(withIds ? { id: `legacy-${index}` } : {})
      }, '2026-10-24T10:03:00.010Z')),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-legacy' }, '2026-10-24T10:03:00.030Z')
    ].join('\n') + '\n'
    const parsed = parseCodexRollout(content, 'run-legacy')
    expect(parsed.turns[0].userText).toBe('initial')
    const steers = parsed.turns[0].events.filter(event => event.kind === 'human' && event.stage === 'steer')
    expect(steers.map(event => event.steer?.prompt)).toEqual(['repeat', 'repeat'])
    expect(new Set(steers.map(event => event.steer?.messageId)).size).toBe(2)
  })

  it('retains canonical steering that has no legacy notification instead of requiring equal source counts', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-asymmetric' }, '2026-10-24T10:04:00.000Z'),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'initial' }] }, '2026-10-24T10:04:00.010Z'),
      row('event_msg', { type: 'user_message', message: 'initial' }, '2026-10-24T10:04:00.011Z'),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'steer' }] }, '2026-10-24T10:04:00.020Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-asymmetric' }, '2026-10-24T10:04:00.030Z')
    ].join('\n') + '\n'
    const parsed = parseCodexRollout(content, 'run-asymmetric')
    expect(parsed.turns[0].userText).toBe('initial')
    expect(parsed.turns[0].events.filter(event => event.kind === 'human').map(event => event.steer?.prompt)).toEqual(['steer'])
  })

  it.each([
    { input: '<skill><name>fixture-skill</name></skill>', expected: '/fixture-skill initial' },
    { input: '# AGENTS.md instructions\ncontext', expected: 'initial' },
    { input: '<environment_context>context</environment_context>', expected: 'initial' },
    { input: '<recommended_plugins>context</recommended_plugins>', expected: 'initial' }
  ])('does not mistake injected context for the canonical human-input stream: $input', ({ input, expected }) => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-context' }, '2026-10-24T10:06:00.000Z'),
      row('event_msg', { type: 'user_message', message: 'initial' }, '2026-10-24T10:06:00.010Z'),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }, '2026-10-24T10:06:00.020Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-context' }, '2026-10-24T10:06:00.030Z')
    ].join('\n') + '\n'
    const turn = parseCodexRollout(content, 'run-context').turns[0]
    expect(turn.userText).toBe(expected)
    expect(turn.events.filter(event => event.kind === 'human')).toHaveLength(0)
  })

  it('derives ID-less steering identity from the native input ordinal, not later tool activity', () => {
    const inputs = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-stable' }, '2026-10-24T10:05:00.000Z'),
      ...['initial', 'steer'].map(text => row('response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text }]
      }, '2026-10-24T10:05:00.010Z'))
    ]
    const end = row('event_msg', { type: 'task_complete', turn_id: 'turn-stable' }, '2026-10-24T10:05:00.030Z')
    const tool = row('response_item', { type: 'function_call', call_id: 'later-tool', name: 'exec', arguments: '{}' }, '2026-10-24T10:05:00.020Z')
    const id = (rows: string[]) => parseCodexRollout(rows.join('\n') + '\n', 'run-stable').turns[0]
      .events.find(event => event.kind === 'human')?.steer?.messageId
    expect(id([...inputs, end])).toBeDefined()
    expect(id([...inputs, end])).toBe(id([...inputs, tool, end]))
  })
})

describe('Codex rollout context compactions', () => {
  const compacted = (timestamp: string, replacement: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'compacted', timestamp, payload: { message: '', replacement_history: [], ...replacement } })
  const compactions = (content: string) => parseCodexRollout(content, 'run-compaction').turns
    .flatMap(turn => turn.events.filter(event => event.kind === 'harness' && event.stage === 'context_compaction'))

  it('records a top-level compacted row that has no context_compacted notification', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-compacted' }, '2026-11-10T15:48:09.904Z'),
      compacted('2026-11-10T16:00:16.138Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-compacted' }, '2026-11-10T16:00:20.000Z')
    ].join('\n') + '\n'

    expect(compactions(content)).toEqual([
      expect.objectContaining({ ts: '2026-11-10T16:00:16.138Z', runtimeMetadata: { source: 'codex_rollout_compacted' } })
    ])
  })

  it('records one compaction when all four markers describe it', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-paired' }, '2026-11-10T15:48:09.904Z'),
      compacted('2026-11-10T16:00:16.138Z'),
      row('event_msg', { type: 'context_compacted' }, '2026-11-10T16:00:16.140Z'),
      row('response_item', { type: 'compaction', encrypted_content: 'opaque' }, '2026-11-10T16:00:16.141Z'),
      row('event_msg', { type: 'item_completed', item: { type: 'ContextCompaction' } }, '2026-11-10T16:00:16.155Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-paired' }, '2026-11-10T16:00:20.000Z')
    ].join('\n') + '\n'

    expect(compactions(content)).toEqual([
      expect.objectContaining({ ts: '2026-11-10T16:00:16.138Z', runtimeMetadata: { source: 'codex_rollout_compacted' } })
    ])
  })

  it('records a completed ContextCompaction item without any other marker', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-item' }, '2026-11-10T15:48:09.904Z'),
      row('event_msg', { type: 'item_started', item: { type: 'ContextCompaction', id: 'compact-1' } }, '2026-11-10T16:00:10.000Z'),
      row('event_msg', { type: 'item_completed', item: { type: 'ContextCompaction', id: 'compact-1' } }, '2026-11-10T16:00:16.155Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-item' }, '2026-11-10T16:00:20.000Z')
    ].join('\n')

    expect(compactions(content)).toEqual([
      expect.objectContaining({ ts: '2026-11-10T16:00:16.155Z', runtimeMetadata: { source: 'codex_rollout_item_completed_context_compaction' } })
    ])
  })

  it.each([false, true])('pairs ContextCompaction with compacted regardless of row order (reverse=%s)', reverse => {
    const markers = [
      compacted('2026-11-10T16:00:16.138Z'),
      row('event_msg', { type: 'item_completed', item: { type: 'ContextCompaction', id: 'compact-1' } }, '2026-11-10T16:00:16.155Z')
    ]
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-item-paired' }, '2026-11-10T15:48:09.904Z'),
      ...(reverse ? markers.reverse() : markers),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-item-paired' }, '2026-11-10T16:00:20.000Z')
    ].join('\n')

    expect(compactions(content)).toEqual([
      expect.objectContaining({ ts: '2026-11-10T16:00:16.138Z', runtimeMetadata: { source: 'codex_rollout_compacted' } })
    ])
  })

  it('inserts compactions by timestamp and preserves existing equal-time event order', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-ordered' }, '2026-11-10T16:00:00.000Z'),
      compacted('2026-11-10T16:00:01.000Z'),
      row('event_msg', { type: 'agent_message', message: 'before' }, '2026-11-10T16:00:10.000Z'),
      row('event_msg', { type: 'agent_message', message: 'equal-first' }, '2026-11-10T16:00:16.138Z'),
      compacted('2026-11-10T16:00:16.138Z'),
      row('event_msg', { type: 'agent_message', message: 'equal-second' }, '2026-11-10T16:00:16.138Z'),
      row('event_msg', { type: 'agent_message', message: 'after' }, '2026-11-10T16:00:20.000Z'),
      row('event_msg', { type: 'item_completed', item: { type: 'ContextCompaction' } }, '2026-11-10T16:00:30.000Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-ordered' }, '2026-11-10T16:00:40.000Z')
    ].join('\n')

    const events = parseCodexRollout(content, 'run-ordered').turns[0].events
    expect(events.map(event => event.text ?? event.stage)).toEqual([
      'context_compaction', 'before', 'equal-first', 'equal-second', 'context_compaction', 'after', 'context_compaction'
    ])
    const timestamps = events.map(event => Date.parse(event.ts))
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b))
  })

  it('keeps two compactions that are minutes apart', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-twice' }, '2026-11-10T15:48:09.904Z'),
      compacted('2026-11-10T16:00:16.138Z'),
      row('event_msg', { type: 'context_compacted' }, '2026-11-10T16:10:16.138Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-twice' }, '2026-11-10T16:11:00.000Z')
    ].join('\n') + '\n'

    expect(compactions(content).map(event => [event.ts, (event.runtimeMetadata as Record<string, unknown>).source])).toEqual([
      ['2026-11-10T16:00:16.138Z', 'codex_rollout_compacted'],
      ['2026-11-10T16:10:16.138Z', 'codex_rollout_context_compacted']
    ])
  })

  it('keeps a re-read compaction row with the turn whose window owns it', () => {
    const content = [
      row('event_msg', { type: 'task_started', turn_id: 'turn-owner' }, '2026-11-10T15:48:09.904Z'),
      compacted('2026-11-10T16:00:16.138Z'),
      row('event_msg', { type: 'task_started', turn_id: 'turn-later' }, '2026-11-10T16:17:13.503Z'),
      row('event_msg', { type: 'task_complete', turn_id: 'turn-later' }, '2026-11-10T16:23:28.181Z')
    ].join('\n') + '\n'

    const parsed = parseCodexRollout(content, 'run-overlap')
    const count = (turnId: string) => parsed.turns
      .filter(turn => turn.providerTurnId === turnId)
      .flatMap(turn => turn.events)
      .filter(event => event.stage === 'context_compaction')
      .length
    expect([count('turn-owner'), count('turn-later')]).toEqual([1, 0])
  })
})
