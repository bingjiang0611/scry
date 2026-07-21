import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

import { runAgent } from './agent-runner'

describe('Claude Agent SDK launch options', () => {
  beforeEach(() => sdk.query.mockReset())

  it('uses the selected executable and passes the explicit dangerous-skip flag', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {}
    })

    await runAgent('probe', 'run-probe', () => {}, {
      claudePath: '/Users/example/.local/bin/claude',
      settingSources: ['project', 'local']
    }).promise

    expect(sdk.query).toHaveBeenCalledWith({
      prompt: 'probe',
      options: expect.objectContaining({
        pathToClaudeCodeExecutable: '/Users/example/.local/bin/claude',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        extraArgs: { 'dangerously-skip-permissions': null },
        settingSources: ['project', 'local']
      })
    })
  })

  it('does not append the completed assistant snapshot after partial text deltas', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'K' } } }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }
      }
    })
    const emitted: Array<{ kind: string; text?: string }> = []

    await runAgent('probe', 'run-probe', (event) => emitted.push(event), {}).promise

    expect(emitted.filter((event) => event.kind === 'model').map((event) => event.text).join('')).toBe('OK')
  })

  it('bridges AskUserQuestion answers through canUseTool without changing bypass for other tools', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {}
    })
    const requestUserInput = vi.fn(async (request) => ({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered' as const,
      answers: { '选择流程？': '全量' }
    }))

    const handle = runAgent('probe', 'run-probe', () => {}, { requestUserInput })
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

  it('returns a non-interrupting denial when the user cancels a question', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {}
    })
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
