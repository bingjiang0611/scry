import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sdk = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

import { runAgent } from './agent-runner'
import { ProviderEventLog } from './provider-event-log'
import type { AgentQuestionRequest } from '../shared/runtime'
import { WorkflowLiveObservationTracker } from './workflow-live-observation'

const successResult = (sessionId = 'claude-session') => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: sessionId
})

function completedQuery(...messages: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
      yield successResult()
    }
  }
}

describe('Claude Agent SDK launch options', () => {
  beforeEach(() => sdk.query.mockReset())

  it('uses the selected executable and keeps the safe approval default', async () => {
    sdk.query.mockReturnValue(completedQuery())

    await runAgent('probe', 'run-probe', () => {}, {
      claudePath: '/Users/example/.local/bin/claude',
      settingSources: ['project', 'local']
    }).promise

    expect(sdk.query).toHaveBeenCalledWith({
      prompt: 'probe',
      options: expect.objectContaining({
        pathToClaudeCodeExecutable: '/Users/example/.local/bin/claude',
        settingSources: ['project', 'local']
      })
    })
    expect(sdk.query.mock.calls[0][0].options).not.toHaveProperty('allowDangerouslySkipPermissions')
  })

  it('passes model, effort, and auto-review without dangerous-skip flags', async () => {
    sdk.query.mockReturnValue(completedQuery())
    await runAgent('probe', 'run-probe', () => {}, {
      model: 'claude-test',
      effort: 'high',
      permissionMode: 'auto_review'
    }).promise
    expect(sdk.query).toHaveBeenCalledWith({
      prompt: 'probe',
      options: expect.objectContaining({
        model: 'claude-test',
        effort: 'high',
        permissionMode: 'auto'
      })
    })
    expect(sdk.query.mock.calls[0][0].options).not.toHaveProperty('allowDangerouslySkipPermissions')
  })

  it('maps auto_accept_edits to the SDK acceptEdits mode without dangerous-skip flags', async () => {
    sdk.query.mockReturnValue(completedQuery())
    await runAgent('probe', 'run-probe', () => {}, { permissionMode: 'auto_accept_edits' }).promise
    expect(sdk.query).toHaveBeenCalledWith({
      prompt: 'probe',
      options: expect.objectContaining({ permissionMode: 'acceptEdits' })
    })
    expect(sdk.query.mock.calls[0][0].options).not.toHaveProperty('allowDangerouslySkipPermissions')
  })

  it('does not append the completed assistant snapshot after partial text deltas', async () => {
    sdk.query.mockReturnValue(completedQuery(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'K' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }
    ))
    const emitted: Array<{ kind: string; text?: string }> = []

    await runAgent('probe', 'run-probe', (event) => emitted.push(event), {}).promise

    expect(emitted.filter((event) => event.kind === 'model').map((event) => event.text).join('')).toBe('OK')
  })

  it('observes only nonempty root Claude text and thinking deltas without changing output or native recording', async () => {
    sdk.query.mockReturnValue(completedQuery(
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'root' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reason' } } },
      { type: 'stream_event', parent_tool_use_id: 'tool-parent', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'child' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { type: 'text_delta', text: 'not-progress' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig' } } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'root' }] } }
    ))
    const emitted: Array<{ kind: string; text?: string }> = []
    const observations: string[] = []
    const nativeTypes: string[] = []

    await runAgent('probe', 'run-native-observation', (event) => emitted.push(event), {
      recordNative: (type) => nativeTypes.push(type),
      onWorkflowObservation: (observation) => {
        if (observation.kind === 'model_progress') observations.push(observation.channel)
      }
    }).promise

    expect(observations).toEqual(['text', 'thinking'])
    expect(emitted.filter((event) => event.kind === 'model').map((event) => event.text).join('')).toBe('rootchildroot')
    expect(nativeTypes).toEqual(['stream_event', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'assistant', 'result'])
  })

  it('does not enumerate all pending calls to observe one native tool result', async () => {
    const entries = Map.prototype.entries
    let enumerated = 0
    const spy = vi.spyOn(Map.prototype, 'entries').mockImplementation(function (this: Map<unknown, unknown>) {
      if (this.has('call-no-scan')) enumerated++
      return entries.call(this)
    })
    try {
      sdk.query.mockReturnValue(completedQuery(
        { type: 'system', subtype: 'init', session_id: 'claude-session' },
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'call-no-scan', name: 'Read', input: { file_path: '/fixture/file' } }] } },
        { type: 'tool_progress', tool_use_id: 'call-no-scan', parent_tool_use_id: null, session_id: 'claude-session' },
        { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'call-no-scan', content: 'ok' }] } }
      ))
      await runAgent('probe', 'run-no-scan', () => {}, { onWorkflowObservation: () => {} }).promise
      expect(enumerated).toBe(0)
    } finally { spy.mockRestore() }
  })

  it('does not change normalized trace correlation when workflow observation is enabled', async () => {
    const messages = [
      { type: 'system', subtype: 'init', session_id: 'claude-session' },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'call-root', name: 'Read', input: { file_path: '/fixture/file' } }] } },
      { type: 'tool_progress', tool_use_id: 'call-root', parent_tool_use_id: null, session_id: 'claude-session' },
      { type: 'user', parent_tool_use_id: null, session_id: 'wrong-session', message: { content: [{ type: 'tool_result', tool_use_id: 'call-root', content: 'foreign' }] } },
      { type: 'user', parent_tool_use_id: null, session_id: 'claude-session', message: { content: [{ type: 'tool_result', tool_use_id: 'call-root', content: 'actual' }] } }
    ]
    const execute = async (observed: boolean) => {
      sdk.query.mockReturnValue(completedQuery(...messages))
      const trace: unknown[] = []
      const native: string[] = []
      await runAgent('probe', 'run-observer-noninterference', event => trace.push({
        kind: event.kind, stage: event.stage, toolUseId: event.toolUseId,
        tool: event.tool, name: event.name, parentToolUseId: event.parentToolUseId,
        output: event.output, text: event.text
      }), { recordNative: (type, payload) => native.push(JSON.stringify({ type, payload })),
        ...(observed ? { onWorkflowObservation: () => {} } : {}) }).promise
      return { trace, native }
    }
    const ordinary = await execute(false)
    expect(await execute(true)).toEqual(ordinary)
  })

  it('observes root Claude pending-call activity and matching returns through the normalized tool ID map', async () => {
    sdk.query.mockReturnValue(completedQuery(
      { type: 'system', subtype: 'init', session_id: 'claude-session' },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'call-root', name: 'Bash', input: { command: 'true' } }] } },
      { type: 'tool_progress', tool_use_id: 'call-root', parent_tool_use_id: null, session_id: 'claude-session', heartbeat: true },
      { type: 'tool_progress', tool_use_id: 'call-root', parent_tool_use_id: null, session_id: 'claude-session', heartbeat: true },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'call-root', content: 'ok' }] } },
      { type: 'tool_progress', tool_use_id: 'call-root', parent_tool_use_id: null, session_id: 'claude-session', heartbeat: true }
    ))
    const observations: Array<{ kind: string; toolCallId?: string }> = []
    const tracker = new WorkflowLiveObservationTracker({ taskId: 'task', attemptId: 'attempt', runId: 'run-tool-pending', providerId: 'claude' })
    await runAgent('probe', 'run-tool-pending', () => {}, {
      onWorkflowObservation: observation => { observations.push(observation); tracker.observe(observation) }
    }).promise
    expect(observations).toEqual([
      { source: 'claude_native', kind: 'tool_activity', toolCallId: 'call-root' },
      { source: 'claude_native', kind: 'tool_activity', toolCallId: 'call-root' },
      { source: 'claude_native', kind: 'tool_returned', toolCallId: 'call-root' }
    ])
    expect(tracker.snapshot()).toMatchObject({ status: 'unknown', activeToolIds: [], trackedToolCount: 0 })
  })

  it('keeps an observed call pending across replay and foreign results without restoring trace correlation', async () => {
    const tracker = new WorkflowLiveObservationTracker({ taskId: 'task', attemptId: 'attempt', runId: 'run-tool-gates', providerId: 'claude' })
    const pendingSnapshots: string[][] = []
    const observations: Array<{ kind: string; toolCallId?: string }> = []
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'claude-session' }
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'call-root', name: 'Bash', input: { command: 'true' } }] } }
        yield { type: 'tool_progress', tool_use_id: 'call-root', parent_tool_use_id: null, session_id: 'claude-session' }
        yield { type: 'assistant', parent_tool_use_id: 'call-root', message: { content: [{ type: 'tool_use', id: 'call-child', name: 'Bash', input: { command: 'true' } }] } }
        yield { type: 'tool_progress', tool_use_id: 'call-child', parent_tool_use_id: 'call-root', session_id: 'claude-session' }
        yield { type: 'tool_progress', tool_use_id: 'call-root', parent_tool_use_id: null, session_id: 'wrong-session' }
        yield { type: 'tool_progress', tool_use_id: 'unknown', parent_tool_use_id: null, session_id: 'claude-session' }
        yield { type: 'user', parent_tool_use_id: null, isReplay: true, message: { content: [{ type: 'tool_result', tool_use_id: 'call-root', content: 'replayed' }] } }
        pendingSnapshots.push(tracker.snapshot().activeToolIds)
        // The shared normalizer has consumed its correlation entry. A diagnostic
        // observer must not restore it or invent further activity from that gap.
        yield { type: 'tool_progress', tool_use_id: 'call-root', parent_tool_use_id: null, session_id: 'claude-session' }
        yield { type: 'user', parent_tool_use_id: null, session_id: 'wrong-session', message: { content: [{ type: 'tool_result', tool_use_id: 'call-root', content: 'wrong' }] } }
        yield { type: 'system', subtype: 'task_notification', session_id: 'claude-session', task_id: 'task-1', status: 'completed' }
        pendingSnapshots.push(tracker.snapshot().activeToolIds)
        yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'call-root', is_error: true, content: 'denied' }] } }
        yield successResult()
      }
    })
    await runAgent('probe', 'run-tool-gates', () => {}, {
      onWorkflowObservation: observation => { observations.push(observation); tracker.observe(observation) }
    }).promise
    expect(pendingSnapshots).toEqual([['call-root'], ['call-root']])
    expect(observations).toEqual([
      { source: 'claude_native', kind: 'tool_activity', toolCallId: 'call-root' },
      { source: 'claude_native', kind: 'tool_returned', toolCallId: 'call-root' }
    ])
    expect(tracker.snapshot()).toMatchObject({ status: 'unknown', activeToolIds: [] })
  })

  it('does not coerce a malformed native return identity into a matching observed call', async () => {
    const tracker = new WorkflowLiveObservationTracker({ taskId: 'task', attemptId: 'attempt', runId: 'run-strict-return', providerId: 'claude' })
    let afterMalformed: string[] = []
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'claude-session' }
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: '17', name: 'Read', input: { file_path: '/fixture/file' } }] } }
        yield { type: 'tool_progress', tool_use_id: '17', parent_tool_use_id: null, session_id: 'claude-session' }
        yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 17, content: 'malformed' }] } }
        afterMalformed = tracker.snapshot().activeToolIds
        yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: '17', content: 'actual' }] } }
        yield successResult()
      }
    })
    await runAgent('probe', 'run-strict-return', () => {}, { onWorkflowObservation: observation => { tracker.observe(observation) } }).promise
    expect(afterMalformed).toEqual(['17'])
    expect(tracker.snapshot()).toMatchObject({ activeToolIds: [], trackedToolCount: 0 })
  })

  it('does not complete the SDK run when a background launcher returns or sends a task notification', async () => {
    let release!: () => void
    let returned!: () => void
    const terminal = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { returned = resolve })
    const tracker = new WorkflowLiveObservationTracker({ taskId: 'task', attemptId: 'attempt', runId: 'run-background-return', providerId: 'claude' })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'claude-session' }
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'call-background', name: 'Bash', input: { command: 'fixture', run_in_background: true } }] } }
        yield { type: 'tool_progress', tool_use_id: 'call-background', parent_tool_use_id: null, session_id: 'claude-session', task_id: 'task-background', heartbeat: true }
        yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'call-background', content: 'opaque response' }] }, tool_use_result: { task_id: 'task-background', status: 'running' } }
        yield { type: 'tool_progress', tool_use_id: 'call-background', parent_tool_use_id: null, session_id: 'claude-session', task_id: 'task-background', heartbeat: true }
        yield { type: 'system', subtype: 'task_notification', session_id: 'claude-session', task_id: 'task-background', status: 'completed' }
        returned()
        await terminal
        yield successResult()
      }
    })
    let completed = false
    const handle = runAgent('probe', 'run-background-return', () => {}, { onWorkflowObservation: observation => { tracker.observe(observation) } })
    const done = handle.promise.then(result => { completed = true; return result })
    try {
      await waiting
      expect(completed).toBe(false)
      expect(tracker.snapshot()).toMatchObject({ status: 'unknown', trackedToolCount: 0, modelProgressCount: 0 })
    } finally { release(); await done }
    expect(completed).toBe(true)
  })

  it('does not emit activity for a root tool_use without native progress', async () => {
    sdk.query.mockReturnValue(completedQuery(
      { type: 'system', subtype: 'init', session_id: 'claude-session' },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'call-root', name: 'Bash', input: { command: 'true' } }] } }
    ))
    const observations: unknown[] = []
    await runAgent('probe', 'run-tool-no-progress', () => {}, {
      onWorkflowObservation: observation => observations.push(observation)
    }).promise
    expect(observations).toEqual([])
  })

  it('does not parse workflow delta observations for ordinary non-workflow runs', async () => {
    const deltaReads = async (observe: boolean) => {
      let reads = 0
      const event = { type: 'content_block_delta', get delta() { reads++; return { type: 'text_delta', text: 'root' } } }
      sdk.query.mockReturnValue(completedQuery({ type: 'stream_event', parent_tool_use_id: null, event }))
      await runAgent('probe', 'run-delta-read-count', () => {}, observe ? { onWorkflowObservation: () => {} } : {}).promise
      return reads
    }
    const ordinary = await deltaReads(false)
    expect(await deltaReads(true)).toBeGreaterThan(ordinary)
  })

  it('fails open and bounds warnings when the workflow observation callback repeatedly throws', async () => {
    sdk.query.mockReturnValue(completedQuery(
      ...['root', ' next', ' last'].map(text => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }))
    ))
    const emitted: Array<{ kind: string; text?: string }> = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(runAgent('probe', 'run-observation-failure', (event) => emitted.push(event), {
        onWorkflowObservation: () => { throw new Error('diagnostic callback failure') }
      }).promise).resolves.toMatchObject({ status: 'completed' })
      expect(emitted.some((event) => event.kind === 'model' && event.text === 'root')).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Claude workflow observation failed (run-observation-failure):'), expect.any(Error))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(emitted.filter(event => event.kind === 'model').map(event => event.text).join('')).toBe('root next last')
    } finally {
      warn.mockRestore()
    }
  })

  it('propagates a non-success SDK result as a failed Provider run', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['context_length_exceeded: prompt is too long']
        }
      }
    })

    await expect(runAgent('probe', 'run-probe', () => {}, {}).promise).resolves.toMatchObject({ status: 'failed' })
  })

  it('captures the root native prompt id without letting task notifications replace it', async () => {
    let release = (): void => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await waiting
        yield successResult()
      }
    })

    const handle = runAgent('probe', 'run-probe', () => {}, { captureProviderTurnId: true })
    const hook = sdk.query.mock.calls[0][0].options.hooks.UserPromptSubmit[0].hooks[0]
    await hook({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification>early background result</task-notification>',
      turn_id: 'notification-before-root',
      origin: { kind: 'task-notification' }
    })
    await hook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'probe',
      prompt_id: 'root-prompt-id',
      turn_id: 'different-turn-id'
    })
    await hook({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification>later background result</task-notification>',
      turn_id: 'notification-after-root'
    })

    expect(handle.getProviderTurnId?.()).toBe('root-prompt-id')
    release()
    await expect(handle.promise).resolves.toMatchObject({ providerTurnId: 'root-prompt-id' })
  })

  it('resolves the authoritative promptId from the hook transcript when the hook has no turn id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-claude-turn-id-'))
    const transcript = join(root, 'session.jsonl')
    await writeFile(transcript, '')
    let release = (): void => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await waiting
        yield successResult()
      }
    })

    try {
      const handle = runAgent('/rate-workflow 85781174 理解prd后停下', 'run-transcript-id', () => {}, {
        captureProviderTurnId: true
      })
      const hook = sdk.query.mock.calls[0][0].options.hooks.UserPromptSubmit[0].hooks[0]
      await hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session',
        transcript_path: transcript,
        prompt: '/rate-workflow 85781174 理解prd后停下'
      })
      await writeFile(transcript, `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-session',
        promptId: 'authoritative-prompt-id',
        message: {
          role: 'user',
          content: '<command-name>/rate-workflow</command-name><command-args>85781174 理解prd后停下</command-args>'
        }
      })}\n`)
      release()

      await expect(handle.promise).resolves.toMatchObject({
        sessionId: 'claude-session',
        providerTurnId: 'authoritative-prompt-id'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers the transcript promptId before rethrowing the original Provider error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-claude-failed-turn-id-'))
    const transcript = join(root, 'session.jsonl')
    const providerError = new Error('Claude transport failed')
    let release = (): void => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await waiting
        throw providerError
      }
    })

    try {
      await writeFile(transcript, '')
      const handle = runAgent('probe', 'run-failed-transcript-id', () => {}, { captureProviderTurnId: true })
      const hook = sdk.query.mock.calls[0][0].options.hooks.UserPromptSubmit[0].hooks[0]
      await hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session',
        transcript_path: transcript,
        prompt: 'probe'
      })
      await writeFile(transcript, `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-session',
        promptId: 'failed-prompt-id',
        message: { role: 'user', content: 'probe' }
      })}\n`)
      release()

      await expect(handle.promise).rejects.toBe(providerError)
      expect(handle.getProviderTurnId?.()).toBe('failed-prompt-id')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not bind an older identical transcript prompt when the current turn fails before persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-claude-old-turn-id-'))
    const transcript = join(root, 'session.jsonl')
    const providerError = new Error('Claude transport failed before current user persistence')
    let release = (): void => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await waiting
        throw providerError
      }
    })

    try {
      await writeFile(transcript, `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-session',
        promptId: 'old-prompt-id',
        message: { role: 'user', content: 'same prompt' }
      })}\n`)
      const handle = runAgent('same prompt', 'run-failed-before-persist', () => {}, { captureProviderTurnId: true })
      const hook = sdk.query.mock.calls[0][0].options.hooks.UserPromptSubmit[0].hooks[0]
      await hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session',
        transcript_path: transcript,
        prompt: 'same prompt'
      })
      release()

      await expect(handle.promise).rejects.toBe(providerError)
      expect(handle.getProviderTurnId?.()).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not bind a prompt from a transcript file replaced after the hook baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-claude-replaced-transcript-'))
    const transcript = join(root, 'session.jsonl')
    let release = (): void => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        await waiting
        yield successResult()
      }
    })

    try {
      await writeFile(transcript, '')
      const handle = runAgent('same prompt', 'run-replaced-transcript', () => {}, { captureProviderTurnId: true })
      const hook = sdk.query.mock.calls[0][0].options.hooks.UserPromptSubmit[0].hooks[0]
      await hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session',
        transcript_path: transcript,
        prompt: 'same prompt'
      })
      const replacement = `${transcript}.replacement`
      await writeFile(replacement, `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-session',
        promptId: 'replacement-prompt-id',
        message: { role: 'user', content: 'same prompt' }
      })}\n`)
      await rm(transcript)
      await rename(replacement, transcript)
      release()

      await expect(handle.promise).resolves.toMatchObject({ providerTurnId: undefined })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an SDK stream that ends without a terminal result', async () => {
    sdk.query.mockReturnValue({ async *[Symbol.asyncIterator]() {} })

    await expect(runAgent('probe', 'run-empty', () => {}, {}).promise)
      .rejects.toThrow('Claude Agent SDK stream ended without a terminal result')
  })

  it('allows an interrupted stream to end without a terminal result', async () => {
    let release = (): void => {}
    const waiting = new Promise<void>((resolve) => { release = resolve })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() { await waiting },
      interrupt: release
    })

    const handle = runAgent('probe', 'run-interrupted', () => {}, {})
    handle.interrupt()
    await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
  })

  it('preserves an early Provider error and logs only bounded redacted stderr', async () => {
    const providerError = new Error('Claude process terminated by signal SIGKILL')
    const bearer = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const apiKey = 'must-not-enter-log'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sdk.query.mockImplementation((request) => {
      if (!request) return completedQuery()
      request.options.stderr(`${'x'.repeat(4_000)} Authorization: Bearer ${bearer}\nAPI_KEY=${apiKey}`)
      return {
        async *[Symbol.asyncIterator]() {
          throw providerError
        }
      }
    })

    try {
      const handle = runAgent('probe', 'run-early-failure', () => {}, { captureProviderTurnId: true })
      await expect(handle.promise).rejects.toBe(providerError)
      expect(handle.getProviderTurnId?.()).toBeUndefined()
      const diagnostic = warn.mock.calls.flat().join(' ')
      expect(diagnostic).toContain('Claude stderr (run-early-failure, redacted)')
      expect(diagnostic).toContain('Authorization: [redacted]')
      expect(diagnostic).toContain('API_KEY=[redacted]')
      expect(diagnostic).not.toContain(bearer)
      expect(diagnostic).not.toContain(apiKey)
      expect(diagnostic.length).toBeLessThan(2_200)
    } finally {
      warn.mockRestore()
    }
  })

  it('bridges AskUserQuestion answers and keeps full access for other tools', async () => {
    sdk.query.mockReturnValue(completedQuery())
    const requestUserInput = vi.fn(async (request) => ({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered' as const,
      answers: { '选择流程？': '全量' }
    }))

    const handle = runAgent('probe', 'run-probe', () => {}, { requestUserInput, permissionMode: 'full_access' })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool as (
      tool: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; toolUseID: string }
    ) => Promise<Record<string, unknown>>
    const input = {
      questions: [
        {
          question: '选择流程？',
          header: '流程',
          multiSelect: false,
          options: [
            { label: '全量', description: '完整执行' },
            { label: '快速', description: '缩短流程' }
          ]
        }
      ]
    }

    await expect(
      canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'tool-1' })
    ).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { '选择流程？': '全量' } },
      decisionClassification: 'user_temporary'
    })
    await expect(
      canUseTool('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tool-2' })
    ).resolves.toEqual({ behavior: 'allow' })
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-probe', questionId: 'tool-1' }),
      expect.any(AbortSignal)
    )
    await handle.promise
  })

  it('bridges default tool approvals through the inline question channel', async () => {
    sdk.query.mockReturnValue(completedQuery())
    const requestUserInput = vi.fn(async (request) => ({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered' as const,
      answers: { [request.questions[0].question]: '允许一次' }
    }))
    runAgent('probe', 'run-probe', () => {}, { requestUserInput, permissionMode: 'default' })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
    await expect(canUseTool(
      'Bash',
      { command: 'pwd' },
      { signal: new AbortController().signal, toolUseID: 'tool-2', description: 'pwd' }
    )).resolves.toMatchObject({ behavior: 'allow', decisionClassification: 'user_temporary' })
    expect(sdk.query.mock.calls[0][0].options).not.toHaveProperty('permissionMode')
  })

  it('returns only exact session-scoped suggestions and asks again for a different rule', async () => {
    sdk.query.mockReturnValue(completedQuery())
    const requestUserInput = vi.fn(async (request) => ({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered' as const,
      answers: { [request.questions[0].question]: '本次会话允许' }
    }))
    const run = runAgent('probe', 'run-probe', () => {}, { requestUserInput, permissionMode: 'default' })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
    const persistentSuggestion = {
      type: 'addRules' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'Bash(pwd)' }],
      behavior: 'allow' as const,
      destination: 'projectSettings' as const
    }
    const bearerToken = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const firstSessionSuggestion = {
      type: 'addRules' as const,
      rules: [
        { toolName: 'Bash', ruleContent: `curl -H "Authorization: Bearer ${bearerToken}" https://example.test` },
        { toolName: 'Read', ruleContent: '/repo/package.json' }
      ],
      behavior: 'allow' as const,
      destination: 'session' as const
    }
    const secondSessionSuggestion = {
      ...firstSessionSuggestion,
      rules: [{ toolName: 'Bash', ruleContent: 'Bash(git status)' }]
    }

    await expect(canUseTool(
      'Bash',
      { command: 'pwd' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-session-1',
        suggestions: [persistentSuggestion, firstSessionSuggestion]
      }
    )).resolves.toEqual({
      behavior: 'allow',
      updatedPermissions: [firstSessionSuggestion],
      decisionClassification: 'user_permanent'
    })
    await expect(canUseTool(
      'Bash',
      { command: 'git status' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-session-2',
        suggestions: [secondSessionSuggestion]
      }
    )).resolves.toEqual({
      behavior: 'allow',
      updatedPermissions: [secondSessionSuggestion],
      decisionClassification: 'user_permanent'
    })

    expect(requestUserInput).toHaveBeenCalledTimes(2)
    expect(requestUserInput.mock.calls[0][0].questions[0].options).toContainEqual(expect.objectContaining({
      label: '本次会话允许',
      description: expect.stringContaining('Bash → curl -H "Authorization: «REDACTED»" https://example.test')
    }))
    expect(requestUserInput.mock.calls[0][0].questions[0].options).toContainEqual(expect.objectContaining({
      label: '本次会话允许',
      description: expect.stringContaining('Read → /repo/package.json')
    }))
    expect(requestUserInput.mock.calls[0][0].questions[0].options[1].description).not.toContain(bearerToken)
    expect(requestUserInput.mock.calls[1][0].questions[0].options).toContainEqual(expect.objectContaining({
      label: '本次会话允许',
      description: expect.stringContaining('1 条精确规则')
    }))
    await run.promise
  })

  it('does not offer or claim session permission without safe exact session suggestions', async () => {
    sdk.query.mockReturnValue(completedQuery())
    const requests: Array<{ questions: Array<{ question: string; options: Array<{ label: string }> }> }> = []
    const requestUserInput = vi.fn(async (request) => {
      requests.push(request)
      return {
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'answered' as const,
        // Forge the hidden answer to verify main still fails closed.
        answers: { [request.questions[0].question]: '本次会话允许' }
      }
    })
    const run = runAgent('probe', 'run-probe', () => {}, { requestUserInput, permissionMode: 'default' })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
    const persistentSuggestion = {
      type: 'addRules' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'Bash(pwd)' }],
      behavior: 'allow' as const,
      destination: 'localSettings' as const
    }
    const exactRule = [{ toolName: 'Bash', ruleContent: 'Bash(pwd)' }]
    const unsafeSessionSuggestions = [
      { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
      { type: 'addDirectories' as const, directories: ['/tmp'], destination: 'session' as const },
      { type: 'removeDirectories' as const, directories: ['/tmp'], destination: 'session' as const },
      { type: 'replaceRules' as const, rules: exactRule, behavior: 'allow' as const, destination: 'session' as const },
      { type: 'removeRules' as const, rules: exactRule, behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: 'Bash' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: ' ', ruleContent: 'Bash(pwd)' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: ' ' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: '*', ruleContent: '*' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'Bash(*)' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [...exactRule, { toolName: 'Read' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: exactRule, behavior: 'ask' as const, destination: 'session' as const }
    ]

    for (const [toolUseID, suggestions] of [
      ['tool-missing', undefined],
      ['tool-empty', []],
      ['tool-persistent', [persistentSuggestion]],
      ['tool-unsafe-session', unsafeSessionSuggestions]
    ] as const) {
      const result = await canUseTool(
        'Bash',
        { command: 'pwd' },
        { signal: new AbortController().signal, toolUseID, ...(suggestions === undefined ? {} : { suggestions }) }
      )
      expect(result).toEqual({ behavior: 'allow', decisionClassification: 'user_temporary' })
    }

    expect(requests).toHaveLength(4)
    for (const request of requests) {
      expect(request.questions[0].options.map((option) => option.label)).toEqual(['允许一次', '拒绝'])
    }
    await run.promise
  })

  it('returns a non-interrupting denial when the user cancels a question', async () => {
    sdk.query.mockReturnValue(completedQuery())
    runAgent('probe', 'run-probe', () => {}, {
      requestUserInput: async (request) => ({
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'cancelled'
      })
    })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
    const result = await canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: '继续？',
            header: '确认',
            multiSelect: false,
            options: [
              { label: '继续', description: '继续执行' },
              { label: '停止', description: '不再执行' }
            ]
          }
        ]
      },
      { signal: new AbortController().signal, toolUseID: 'tool-1' }
    )

    expect(result).toMatchObject({ behavior: 'deny', interrupt: false, decisionClassification: 'user_reject' })
  })
})

describe('双流事件日志与审批 warning', () => {
  beforeEach(() => sdk.query.mockReset())

  it('原生 SDK 消息与归一化事件落进同一个 writer，逐 token 增量不落盘', async () => {
    const logRoot = await mkdtemp(join(tmpdir(), 'scry-dual-stream-'))
    const log = new ProviderEventLog({ root: logRoot })
    const writer = log.writer('claude-run-dual')
    sdk.query.mockReturnValue(completedQuery(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '部' } }, session_id: 'claude-session' },
      { type: 'assistant', message: { id: 'msg-1', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: '部分答案' }] }, session_id: 'claude-session' }
    ))

    const emitted: Array<{ kind: string; stage: string }> = []
    await runAgent('probe', 'run-dual', (event) => {
      emitted.push({ kind: event.kind, stage: event.stage })
      writer.record('canonical', `${event.kind}/${event.stage}`, event)
    }, {
      recordNative: (type, payload) => writer.record('native', type, payload)
    }).promise
    const summary = await writer.close()

    const content = await readFile(join(logRoot, 'claude-run-dual', 'events-000.ndjson'), 'utf8')
    const lines = content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    const native = lines.filter((line) => line.stream === 'native').map((line) => line.type)
    const canonical = lines.filter((line) => line.stream === 'canonical').map((line) => line.type)

    // 原生侧保留 assistant 与 result；stream_event 是瞬时白名单，被计数但不落盘。
    expect(native).toEqual(['assistant', 'result'])
    expect(canonical).toContain('model/text')
    expect(canonical).not.toContain('model/text_delta')
    expect(summary.transientSkipped).toBeGreaterThan(0)
    expect(summary.failed).toBe(false)
    // 序号单调递增，可据此判断某条 canonical 记录由哪条 native 记录派生。
    expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index + 1))
    // 真实流里确实产生过 text_delta，只是没有写进日志。
    expect(emitted.some((event) => event.stage === 'text_delta')).toBe(true)
    await rm(logRoot, { recursive: true, force: true })
  })

  it('SDK 给出 decisionReason 与 blockedPath 时转述进审批问题', async () => {
    sdk.query.mockReturnValue(completedQuery())
    const requests: AgentQuestionRequest[] = []
    await runAgent('probe', 'run-warning', () => {}, {
      requestUserInput: async (request) => {
        requests.push(request)
        return { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' }
      }
    }).promise
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
    await canUseTool('Bash', { command: 'cat /etc/hosts' }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-warn',
      decisionReason: '\u001B[31mask rule: Bash(cat:*)\u001B[0m',
      blockedPath: '/etc/hosts'
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].questions[0].warning).toBe('ask rule: Bash(cat:*)；越界路径：/etc/hosts')
  })

  it('没有 decisionReason 时不编造风险说明', async () => {
    sdk.query.mockReturnValue(completedQuery())
    const requests: AgentQuestionRequest[] = []
    await runAgent('probe', 'run-no-warning', () => {}, {
      requestUserInput: async (request) => {
        requests.push(request)
        return { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' }
      }
    }).promise
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
    await canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tool-plain' })

    expect(requests).toHaveLength(1)
    expect(requests[0].questions[0].warning).toBeUndefined()
  })
})
