import { describe, expect, it } from 'vitest'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  exactSessionPermissionDescription,
  exactSessionPermissionSuggestions,
  MAX_AGENT_PERMISSION_SESSION_DESCRIPTION_LENGTH,
  classifyRunTermination,
  normalizeAgentQuestionRequest,
  normalizeAgentQuestionResponse,
  normalizeAgentStartRequest,
  providerIdForRuntime,
  runtimeProviderForAgentId,
  runtimeProviderForProviderId
} from './runtime'

describe('provider termination semantics', () => {
  it('separates input overflow from output truncation using structured reasons first', () => {
    expect(classifyRunTermination({ rawReason: 'max_tokens' })).toBe('output_token_limit')
    expect(classifyRunTermination({ rawReason: 'length' })).toBe('output_token_limit')
    expect(classifyRunTermination({ message: 'output token limit reached' })).toBe('output_token_limit')
    expect(classifyRunTermination({ rawReason: 'model_context_window_exceeded' })).toBe('model_context_window_exceeded')
    expect(classifyRunTermination({ message: 'context_length_exceeded: prompt is too long' })).toBe('input_context_overflow')
    expect(classifyRunTermination({ message: 'input token limit exceeded' })).toBe('input_context_overflow')
  })

  it('does not guess a direction from an ambiguous token-limit phrase', () => {
    expect(classifyRunTermination({ message: 'token limit reached' })).toBeUndefined()
    expect(classifyRunTermination({ subtype: 'error_max_turns' })).toBe('max_turns')
    expect(classifyRunTermination({ subtype: 'error_max_budget_usd' })).toBe('budget_exceeded')
  })
})

describe('runtime frontdoor mapping', () => {
  it('maps supported UI agents to runtime providers without falling back for unknown agents', () => {
    expect(runtimeProviderForAgentId('claude')).toBe('claude_sdk')
    expect(runtimeProviderForAgentId('codex')).toBe('codex_cli')
    expect(runtimeProviderForAgentId('qoder')).toBe('qoder_cli')
    expect(runtimeProviderForAgentId('opencode')).toBe('opencode_server')
    expect(runtimeProviderForAgentId('cursor')).toBeUndefined()
  })

  it('keeps stable provider ids separate from runtime transports', () => {
    expect(providerIdForRuntime('codex_cli')).toBe('codex')
    expect(providerIdForRuntime('opencode_server')).toBe('opencode')
    expect(runtimeProviderForProviderId('qoder')).toBe('qoder_cli')
  })

  it('normalizes legacy prompt-only starts to Claude local defaults', () => {
    expect(normalizeAgentStartRequest({ prompt: 'hi' })).toEqual({
      prompt: 'hi',
      providerId: 'claude',
      agentId: 'claude',
      backend: 'local',
      runtimeProvider: 'claude_sdk',
      attachments: [],
      permissionMode: 'default'
    })
  })

  it('normalizes explicit run controls and rejects unknown permission modes', () => {
    expect(
      normalizeAgentStartRequest({
        prompt: 'hi',
        providerId: 'opencode',
        expectedExternalSessionId: 'session-a',
        model: { providerId: 'openai', id: ' gpt-test ' },
        effort: ' high ',
        permissionMode: 'default'
      })
    ).toMatchObject({
      model: { providerId: 'openai', id: 'gpt-test' },
      expectedExternalSessionId: 'session-a',
      effort: 'high',
      permissionMode: 'default'
    })
    expect(() =>
      normalizeAgentStartRequest({ prompt: 'hi', permissionMode: 'unsafe' as never })
    ).toThrow('不受支持')
    expect(normalizeAgentStartRequest({ prompt: 'new', expectedExternalSessionId: null }))
      .toMatchObject({ expectedExternalSessionId: null })
  })

  it('maps generic permission answers without exposing native request ids', () => {
    const request = agentPermissionQuestion('run-1', 'permission-1', '权限请求', '允许执行命令？', 'git status')
    expect(agentPermissionDecision(request, {
      runId: 'run-1',
      questionId: 'permission-1',
      behavior: 'answered',
      answers: { '允许执行命令？': '本次会话允许' }
    })).toBe('session')
    expect(agentPermissionDecision(request, {
      runId: 'run-1',
      questionId: 'permission-1',
      behavior: 'cancelled'
    })).toBe('reject')
  })

  it('only offers session permission when requested and explains its exact scope', () => {
    const onceOnly = agentPermissionQuestion(
      'run-1',
      'permission-once',
      '权限请求',
      '允许执行命令？',
      'git status',
      false
    )
    expect(onceOnly.questions[0].options.map((option) => option.label)).toEqual(['允许一次', '拒绝'])

    const exactSession = agentPermissionQuestion(
      'run-1',
      'permission-session',
      '权限请求',
      '允许执行命令？',
      'git status',
      true,
      'claude:permission:Bash',
      '仅允许当前 Provider 运行的 1 条精确规则'
    )
    expect(exactSession.questions[0].options.find((option) => option.label === '本次会话允许')).toEqual({
      label: '本次会话允许',
      description: '仅允许当前 Provider 运行的 1 条精确规则'
    })
  })

  it('redacts and bounds exact session permission details', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
    const suggestions = exactSessionPermissionSuggestions([{
      type: 'addRules',
      destination: 'session',
      behavior: 'allow',
      rules: [
        { toolName: 'Bash', ruleContent: `curl --token ${secret}` },
        { toolName: 'Read', ruleContent: '/repo/package.json' }
      ]
    }])
    const description = exactSessionPermissionDescription(suggestions)
    expect(description).toContain('Bash → curl --token «REDACTED»')
    expect(description).toContain('Read → /repo/package.json')
    expect(description).not.toContain(secret)

    const longDescription = exactSessionPermissionDescription(exactSessionPermissionSuggestions([{
      type: 'addRules',
      destination: 'session',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: `echo ${'x'.repeat(5_000)}` }]
    }]))
    expect(longDescription).toBeUndefined()
    expect(MAX_AGENT_PERMISSION_SESSION_DESCRIPTION_LENGTH).toBe(1_200)
  })

  it('keeps an explicit cwd instead of reading mutable navigation state later', () => {
    expect(normalizeAgentStartRequest({ prompt: 'hi', cwd: '/repo/a' })).toMatchObject({
      prompt: 'hi',
      cwd: '/repo/a'
    })
  })

  it('accepts a provider-only start without inventing a conflicting agent identity', () => {
    expect(normalizeAgentStartRequest({ prompt: 'hi', providerId: 'opencode' })).toMatchObject({
      providerId: 'opencode',
      agentId: 'opencode',
      runtimeProvider: 'opencode_server'
    })
  })

  it('rejects unknown agents and conflicting provider identities instead of falling back to Claude', () => {
    expect(() => normalizeAgentStartRequest({ prompt: 'hi', agentId: 'cursor' })).toThrow('尚未注册 Provider adapter')
    expect(() => normalizeAgentStartRequest({ prompt: 'hi', agentId: 'qoder', providerId: 'codex' })).toThrow('不匹配')
  })

  it('keeps supported image attachments and drops malformed entries', () => {
    expect(
      normalizeAgentStartRequest({
        prompt: '',
        attachments: [
          { kind: 'image', name: 'shot.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=', size: 5 },
          { kind: 'image', name: 'bad.bmp', mimeType: 'image/bmp' as never, dataBase64: 'x' },
          { kind: 'image', name: 'empty.png', mimeType: 'image/png', dataBase64: '' }
        ]
      }).attachments
    ).toEqual([{ kind: 'image', name: 'shot.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=', size: 5 }])
  })

  it('rejects decoded attachment bytes above the per-image and aggregate hard limits', () => {
    const tenMiB = Buffer.alloc(10 * 1024 * 1024).toString('base64')
    const overTenMiB = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')
    expect(() => normalizeAgentStartRequest({
      prompt: '',
      attachments: [{ kind: 'image', name: 'large.png', mimeType: 'image/png', dataBase64: overTenMiB }]
    })).toThrow('超过 10 MiB')
    expect(() => normalizeAgentStartRequest({
      prompt: '',
      attachments: [0, 1, 2].map((index) => ({
        kind: 'image' as const,
        name: `${index}.png`,
        mimeType: 'image/png' as const,
        dataBase64: tenMiB
      }))
    })).toThrow('总大小超过 24 MiB')
  })

  it('normalizes Claude AskUserQuestion payloads without inventing answers', () => {
    const request = normalizeAgentQuestionRequest('run-1', 'tool-1', {
      questions: [
        {
          question: '选择流程？',
          header: '流程',
          multiSelect: false,
          options: [
            { label: '全量', description: '完整执行' },
            { label: '快速', description: '缩短流程', preview: 'preview' }
          ]
        }
      ]
    })

    expect(request).toEqual({
      runId: 'run-1',
      questionId: 'tool-1',
      questionKind: 'clarification',
      source: 'AskUserQuestion',
      questions: [
        {
          question: '选择流程？',
          header: '流程',
          multiSelect: false,
          options: [
            { label: '全量', description: '完整执行' },
            { label: '快速', description: '缩短流程', preview: 'preview' }
          ]
        }
      ]
    })
    expect(normalizeAgentQuestionRequest('run-1', 'tool-1', { questions: [] })).toBeNull()
  })

  it('preserves exact question and option protocol keys and rejects oversized values', () => {
    const request = normalizeAgentQuestionRequest('run-1', 'tool-1', {
      questions: [
        {
          question: ' 选择流程？ ',
          header: '流程',
          multiSelect: false,
          options: [
            { label: ' 全量 ', description: '完整执行' },
            { label: '快速', description: '缩短流程' }
          ]
        }
      ]
    })

    expect(request?.questions[0].question).toBe(' 选择流程？ ')
    expect(request?.questions[0].options[0].label).toBe(' 全量 ')
    expect(
      normalizeAgentQuestionRequest('run-1', 'tool-1', {
        questions: [
          {
            question: 'x'.repeat(2_001),
            header: '流程',
            multiSelect: false,
            options: [
              { label: '全量', description: '完整执行' },
              { label: '快速', description: '缩短流程' }
            ]
          }
        ]
      })
    ).toBeNull()
  })

  it('accepts only complete answers for the matching run and tool call', () => {
    const request = normalizeAgentQuestionRequest('run-1', 'tool-1', {
      questions: [
        {
          question: '选择流程？',
          header: '流程',
          multiSelect: false,
          options: [
            { label: '全量', description: '完整执行' },
            { label: '快速', description: '缩短流程' }
          ]
        },
        {
          question: '启用哪些能力？',
          header: '能力',
          multiSelect: true,
          options: [
            { label: 'MCP', description: '调用 MCP' },
            { label: 'Skill', description: '调用 Skill' }
          ]
        }
      ]
    })!

    expect(
      normalizeAgentQuestionResponse(request, {
        runId: 'run-1',
        questionId: 'tool-1',
        behavior: 'answered',
        answers: { '选择流程？': '全量', '启用哪些能力？': 'MCP, Skill' }
      })
    ).toMatchObject({ behavior: 'answered', answers: { '选择流程？': '全量', '启用哪些能力？': 'MCP, Skill' } })
    expect(
      normalizeAgentQuestionResponse(request, {
        runId: 'run-1',
        questionId: 'tool-1',
        behavior: 'answered',
        answers: { '选择流程？': '全量' }
      })
    ).toBeNull()
    expect(normalizeAgentQuestionResponse(request, { runId: 'stale', questionId: 'tool-1', behavior: 'cancelled' })).toBeNull()
  })
})
