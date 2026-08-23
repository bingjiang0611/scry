import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sdk = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

import { runAgent } from './agent-runner'

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
      await rm(transcript)
      await writeFile(transcript, `${JSON.stringify({
        type: 'user',
        sessionId: 'claude-session',
        promptId: 'replacement-prompt-id',
        message: { role: 'user', content: 'same prompt' }
      })}\n`)
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
