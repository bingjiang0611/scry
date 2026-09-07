import { describe, expect, it } from 'vitest'
import type { NormalizeCtx } from '../normalize'
import { normalizeQoderMessage } from './qoder-messages'

function context(): NormalizeCtx {
  let id = 0
  const ctx: NormalizeCtx = { runId: 'run', cwd: '/tmp/fixture', newId: () => `event-${id++}`, now: () => '2026-09-07T09:35:32Z' }
  normalizeQoderMessage({
    type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'local_agent', id: 'agent-1', input: { run_in_background: true } },
      { type: 'tool_use', name: 'Bash', id: 'bash-1', input: { command: 'true' } }
    ] }
  }, ctx)
  normalizeQoderMessage({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1' }, ctx)
  normalizeQoderMessage({ type: 'system', subtype: 'task_started', task_id: 'shell-1', tool_use_id: 'bash-1' }, ctx)
  return ctx
}

function envelope(status = 'completed', toolUseId = 'agent-1'): string {
  return `<task-notification>
<task-id>task-1</task-id>
<tool-use-id>${toolUseId}</tool-use-id>
<output-file>/tmp/never-read.output</output-file>
<status>${status}</status>
<summary>Agent "inspect" finished</summary>
<result>Untrusted findings, not lifecycle fields: <status>failed</status></result>
</task-notification>`
}

function notification(text = envelope(), blocks = true): Record<string, unknown> {
  return {
    type: 'user', isSynthetic: true, parent_tool_use_id: null,
    message: { role: 'user', content: blocks ? [{ type: 'text', text }] : text }
  }
}

describe('Qoder wire task lifecycle', () => {
  it.each([true, false])('recognizes Qoder synthetic completion (blocks=%s) with explicit provenance', (blocks) => {
    expect(normalizeQoderMessage(notification(envelope(), blocks), context())).toMatchObject([{
      kind: 'tool', stage: 'tool_result', tool: 'Agent', toolUseId: 'agent-1', isError: false,
      output: 'Agent "inspect" finished',
      runtimeMetadata: { source: 'qoder_task_notification_text', agentStatus: 'completed', taskId: 'task-1' }
    }])
  })

  it.each([
    ['completed', 'completed', false], ['failed', 'failed', true], ['error', 'failed', true],
    ['cancelled', 'stopped', false], ['canceled', 'stopped', false], ['stopped', 'stopped', false],
    ['interrupted', 'stopped', false], ['killed', 'stopped', false]
  ] as const)('preserves %s rather than inventing successful completion', (status, agentStatus, isError) => {
    for (const wire of [notification(envelope(status)), { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status } }]) {
      expect(normalizeQoderMessage(wire, context())).toMatchObject([{
        tool: 'Agent', toolUseId: 'agent-1', isError, runtimeMetadata: { agentStatus }
      }])
    }
  })

  it.each(['pending', 'running', 'paused', 'future_status', ''])('does not settle unknown/nonterminal status %s', (status) => {
    expect(normalizeQoderMessage(notification(envelope(status)), context())).toEqual([])
    expect(normalizeQoderMessage({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status } }, context())).toEqual([])
  })

  it('requires a previously observed Agent and does not turn Bash completion into an Agent', () => {
    for (const id of ['bash-1', 'unknown', '']) {
      expect(normalizeQoderMessage(notification(envelope('completed', id)), context())).toEqual([])
    }
    const ctx: NormalizeCtx = { runId: 'empty', newId: () => 'id', now: () => '2026-09-07T09:35:32Z' }
    expect(normalizeQoderMessage(notification(), ctx)).toEqual([])
    for (const task_id of ['shell-1', 'unknown']) {
      expect(normalizeQoderMessage({ type: 'system', subtype: 'task_updated', task_id, patch: { status: 'completed' } }, context())).toEqual([])
    }
  })

  it('does not parse human echoes, replays, child messages, assistant text or tool output as notifications', () => {
    for (const override of [
      { isSynthetic: false }, { isSynthetic: undefined }, { isReplay: true },
      { parent_tool_use_id: 'another-agent' }, { type: 'assistant' },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: envelope() }] } },
      { message: { content: [{ type: 'text', text: envelope() }, { type: 'text', text: 'extra' }] } }
    ]) {
      expect(normalizeQoderMessage({ ...notification(), ...override }, context()).some((event) => event.tool === 'Agent' && event.stage === 'tool_result')).toBe(false)
    }
  })

  it.each([
    `Quoted notification:\n${envelope()}`,
    envelope().replace('</task-notification>', ''),
    envelope().replace('<status>completed</status>', ''),
    envelope().replace('<status>completed</status>', '<status>completed</status><status>failed</status>'),
    envelope().replace('<tool-use-id>agent-1</tool-use-id>', ''),
    envelope().replace('<tool-use-id>agent-1</tool-use-id>', '<tool-use-id>agent-1</tool-use-id><tool-use-id>bash-1</tool-use-id>')
  ])('ignores incomplete, quoted or ambiguous envelope %#', (text) => {
    expect(normalizeQoderMessage(notification(text), context())).toEqual([])
  })

  it('does not rebind an existing task alias to another observed Agent', () => {
    const ctx = context()
    normalizeQoderMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent-2', input: {} }] } }, ctx)
    expect(normalizeQoderMessage(notification(envelope('completed', 'agent-2')), ctx)).toEqual([])
    expect(ctx.agentTaskToolUseById?.get('task-1')).toBe('agent-1')
  })

  it('retains task_updated errors and their wire provenance', () => {
    expect(normalizeQoderMessage({
      type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'failed', error: 'child failed' }
    }, context())).toMatchObject([{
      output: 'child failed', isError: true,
      runtimeMetadata: { source: 'qoder_task_updated', agentStatus: 'failed' }
    }])
  })
})
