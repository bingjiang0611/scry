import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('A2: session-scoped permission rules survive the Provider process', () => {
  beforeEach(() => sdk.query.mockReset())

  it('re-applies accepted session rules when the session is resumed', async () => {
    sdk.query.mockReturnValue(completedQuery())
    await runAgent('probe', 'run-a2', () => {}, {
      resume: 'claude-session-1',
      sessionPermissionRules: {
        rules: () => [{ toolName: 'Bash', ruleContent: 'npm test' }],
        record: () => undefined
      }
    }).promise

    expect(sdk.query.mock.calls[0][0].options.settings).toEqual({
      permissions: { allow: ['Bash(npm test)'] }
    })
  })

  it('records the accepted rules against the live session id', async () => {
    sdk.query.mockReturnValue(completedQuery())
    const recorded: Array<{ sessionId: string; rules: Array<{ toolName: string; ruleContent: string }> }> = []
    await runAgent('probe', 'run-a2-record', () => {}, {
      resume: 'claude-session-2',
      sessionPermissionRules: {
        rules: () => [],
        record: (sessionId, rules) => recorded.push({ sessionId, rules: [...rules] })
      },
      requestUserInput: async (request) => ({
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'answered',
        answers: { [request.questions[0]!.question]: '本次会话允许' }
      })
    }).promise

    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      permission: Record<string, unknown>
    ) => Promise<unknown>
    const decision = await canUseTool(
      'Bash',
      { command: 'npm test' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
        title: '运行命令',
        description: '执行 npm test',
        suggestions: [
          { type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }
        ]
      }
    )
    expect(decision).toMatchObject({ behavior: 'allow', decisionClassification: 'user_permanent' })
    // The rule is stored under the live session id, which the CLI may report after start.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.sessionId).toBeTruthy()
    expect(recorded[0]!.rules).toEqual([{ toolName: 'Bash', ruleContent: 'npm test' }])
  })
})
