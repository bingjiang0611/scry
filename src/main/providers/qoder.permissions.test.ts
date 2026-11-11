import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindQoderTestHelpers, resetQoderTestState } from './qoder.test-support'

const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
vi.mock('node:child_process', () => ({ spawn: t.sdk.spawn }))
vi.mock('../process-diagnostics', async () => (await import('./qoder.test-support')).qoderDiagnosticsModule(t))
vi.mock('@qoder-ai/qoder-agent-sdk', async () => (await import('./qoder.test-support')).qoderSdkModule(t))
vi.mock('./qoder-daemon', async () => (await import('./qoder.test-support')).qoderDaemonModule(t))
vi.mock('../claude-locate', async () => (await import('./qoder.test-support')).qoderLocateModule(t))

import {
  createQoderAdapter
} from './qoder'

const { sdk } = t
const { untilQueried } = bindQoderTestHelpers(t)

describe('Qoder provider adapter · permissions and questions', () => {
  beforeEach(() => resetQoderTestState(t))

  it('bridges AskUserQuestion answers through the Qoder SDK permission callback', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close,
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const requestUserInput = vi.fn(async (request) => ({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered' as const,
      answers: { '选择流程？': '全量' }
    }))

    const run = createQoderAdapter().run({
      runId: 'run-question',
      prompt: 'ask',
      attachments: [],
      emit: vi.fn(),
      permissionMode: 'full_access',
      requestUserInput
    })
    await untilQueried()

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
      expect.objectContaining({ runId: 'run-question', questionId: 'tool-1' }),
      expect.any(AbortSignal)
    )
    await run.promise
  })

  it('only offers and returns Qoder safe exact addRules session suggestions', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const requests: Array<{ questions: Array<{ question: string; options: Array<{ label: string; description: string }> }> }> = []
    const requestUserInput = vi.fn(async (request) => {
      requests.push(request)
      return {
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'answered' as const,
        answers: { [request.questions[0].question]: '本次会话允许' }
      }
    })
    const run = createQoderAdapter().run({
      runId: 'run-permission-scope',
      prompt: 'work',
      attachments: [],
      emit: vi.fn(),
      requestUserInput
    })
    await untilQueried()

    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool
    const sessionSuggestion = {
      type: 'addRules' as const,
      rules: [
        { toolName: 'mcp__tracker__read', ruleContent: 'resource:1' },
        { toolName: 'mcp__tracker__read', ruleContent: 'resource:2' }
      ],
      behavior: 'allow' as const,
      destination: 'session' as const
    }
    const persistentSuggestion = {
      ...sessionSuggestion,
      destination: 'userSettings' as const
    }
    const exactRule = [{ toolName: 'mcp__tracker__read', ruleContent: 'resource:1' }]
    const unsafeSessionSuggestions = [
      { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
      { type: 'addDirectories' as const, directories: ['/tmp'], destination: 'session' as const },
      { type: 'removeDirectories' as const, directories: ['/tmp'], destination: 'session' as const },
      { type: 'replaceRules' as const, rules: exactRule, behavior: 'allow' as const, destination: 'session' as const },
      { type: 'removeRules' as const, rules: exactRule, behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: 'mcp__tracker__read' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: ' ', ruleContent: 'resource:1' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: 'mcp__tracker__read', ruleContent: ' ' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: '*', ruleContent: '*' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [...exactRule, { toolName: 'Read' }], behavior: 'allow' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: exactRule, behavior: 'deny' as const, destination: 'session' as const }
    ]

    await expect(canUseTool(
      'mcp__tracker__read',
      { id: '1' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-session',
        suggestions: [persistentSuggestion, ...unsafeSessionSuggestions, sessionSuggestion]
      }
    )).resolves.toEqual({
      behavior: 'allow',
      updatedPermissions: [sessionSuggestion],
      decisionClassification: 'user_permanent'
    })
    await expect(canUseTool(
      'mcp__tracker__read',
      { id: '2' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-unsafe',
        suggestions: [persistentSuggestion, ...unsafeSessionSuggestions]
      }
    )).resolves.toEqual({ behavior: 'allow', decisionClassification: 'user_temporary' })

    expect(requests[0].questions[0].options).toContainEqual(expect.objectContaining({
      label: '本次会话允许',
      description: expect.stringContaining('mcp__tracker__read → resource:1')
    }))
    expect(requests[0].questions[0].options).toContainEqual(expect.objectContaining({
      label: '本次会话允许',
      description: expect.stringContaining('mcp__tracker__read → resource:2')
    }))
    expect(requests[1].questions[0].options.map((option) => option.label)).toEqual(['允许一次', '拒绝'])
    await run.promise
  })

  it('passes Qoder model effort through model policy and uses auto review', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    await createQoderAdapter().run({
      runId: 'run-controls',
      prompt: 'work',
      attachments: [],
      model: { id: 'performance' },
      effort: 'high',
      permissionMode: 'auto_review',
      emit: vi.fn()
    }).promise
    const options = sdk.query.mock.calls[0][0].options
    expect(options.permissionMode).toBe('auto')
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(options.resolveModel()).toEqual({
      model: 'performance',
      parameters: { reasoningEffort: 'high' }
    })
  })

  it('returns a non-interrupting Qoder denial when the user cancels a question', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const run = createQoderAdapter().run({
      runId: 'run-question-cancel',
      prompt: 'ask',
      attachments: [],
      emit: vi.fn(),
      requestUserInput: async (request) => ({
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'cancelled'
      })
    })
    await untilQueried()

    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool

    await expect(
      canUseTool(
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
    ).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: false,
      decisionClassification: 'user_reject'
    })
    await run.promise
  })
})
