import { describe, expect, it } from 'vitest'
import {
  agentPermissionDecision,
  sanitizeApprovalWarning,
  agentPermissionQuestion,
  exactSessionPermissionDescription,
  exactSessionPermissionSuggestions,
  MAX_AGENT_PERMISSION_SESSION_DESCRIPTION_LENGTH,
  classifyRunTermination,
  decodedBase64ByteLength,
  normalizeAgentQuestionRequest,
  normalizeAgentQuestionResponse,
  normalizeAgentForkSessionRequest,
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
    expect(classifyRunTermination({ message: 'Qoder: http_413' })).toBe('input_context_overflow')
    expect(classifyRunTermination({ message: 'request entity too large' })).toBe('input_context_overflow')
  })

  it('does not guess a direction from an ambiguous token-limit phrase', () => {
    expect(classifyRunTermination({ message: 'token limit reached' })).toBeUndefined()
    expect(classifyRunTermination({ subtype: 'error_max_turns' })).toBe('max_turns')
    expect(classifyRunTermination({ subtype: 'error_max_budget_usd' })).toBe('budget_exceeded')
  })
})

describe('runtime frontdoor mapping', () => {
  it('captures a bounded manual network label without changing runtime controls', () => {
    const request = normalizeAgentStartRequest({ prompt: 'task', networkLabel: '  VPN A  ' })
    expect(request).toMatchObject({ networkLabel: 'VPN A', providerId: 'claude', permissionMode: 'default' })
    expect(normalizeAgentStartRequest({ prompt: 'task', networkLabel: ' ' }).networkLabel).toBeUndefined()
    expect(() => normalizeAgentStartRequest({ prompt: 'task', networkLabel: 'x'.repeat(81) })).toThrow('网络标签')
    expect(() => normalizeAgentStartRequest({ prompt: 'task', networkLabel: 1 as unknown as string })).toThrow('网络标签')
  })
  it('maps supported UI agents to runtime providers without falling back for unknown agents', () => {
    expect(runtimeProviderForAgentId('claude')).toBe('claude_sdk')
    expect(runtimeProviderForAgentId('codex')).toBe('codex_cli')
    expect(runtimeProviderForAgentId('qoder')).toBe('qoder_cli')
    expect(runtimeProviderForAgentId('opencode')).toBe('opencode_server')
    expect(runtimeProviderForAgentId('pi:default')).toBe('pi_rpc')
    expect(runtimeProviderForAgentId('pi:0123456789abcdef')).toBe('pi_rpc')
    expect(runtimeProviderForAgentId('cursor')).toBeUndefined()
  })

  it('keeps stable provider ids separate from runtime transports', () => {
    expect(providerIdForRuntime('codex_cli')).toBe('codex')
    expect(providerIdForRuntime('opencode_server')).toBe('opencode')
    expect(runtimeProviderForProviderId('qoder')).toBe('qoder_cli')
    expect(providerIdForRuntime('pi_rpc')).toBe('pi')
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

  it('normalizes a last-turn fork only with a trusted source session and stable boundaries', () => {
    expect(normalizeAgentStartRequest({
      prompt: 'edited',
      providerId: 'codex',
      expectedExternalSessionId: 'thread-source',
      forkLastTurn: {
        replaceRunId: ' run-last ',
        replaceProviderTurnId: ' turn-last ',
        replaceForkTurnId: ' message-last ',
        previousProviderTurnId: ' turn-previous ',
        previousForkTurnId: ' message-previous '
      }
    })).toMatchObject({
      expectedExternalSessionId: 'thread-source',
      forkLastTurn: {
        replaceRunId: 'run-last',
        replaceProviderTurnId: 'turn-last',
        replaceForkTurnId: 'message-last',
        previousProviderTurnId: 'turn-previous',
        previousForkTurnId: 'message-previous'
      }
    })
    expect(() => normalizeAgentStartRequest({
      prompt: 'edited',
      providerId: 'codex',
      forkLastTurn: { replaceRunId: 'run-last', replaceProviderTurnId: 'turn-last', replaceForkTurnId: 'message-last' }
    })).toThrow('可信会话或轮次边界')
  })

  it('normalizes selected-turn session forks for every Provider', () => {
    expect(normalizeAgentForkSessionRequest({
      providerId: 'codex',
      cwd: '/repo',
      sourceSessionId: ' thread-source ',
      sourceRunId: ' run-selected ',
      sourceProviderTurnId: ' turn-selected ',
      sourceForkTurnId: ' message-selected ',
      model: { id: ' gpt-test ' },
      permissionMode: 'full_access'
    })).toEqual({
      providerId: 'codex',
      cwd: '/repo',
      sourceSessionId: 'thread-source',
      sourceRunId: 'run-selected',
      sourceProviderTurnId: 'turn-selected',
      sourceForkTurnId: 'message-selected',
      model: { id: 'gpt-test' },
      permissionMode: 'full_access'
    })
    for (const providerId of ['claude', 'codex', 'qoder', 'opencode'] as const) {
      expect(normalizeAgentForkSessionRequest({
        providerId,
        sourceSessionId: 'session',
        sourceRunId: 'run',
        sourceProviderTurnId: 'turn',
        sourceForkTurnId: 'message'
      })).toMatchObject({ providerId, permissionMode: 'default' })
    }
    expect(normalizeAgentForkSessionRequest({
      providerId: 'pi',
      agentProfileId: 'pi:default',
      sourceSessionId: 'session',
      sourceRunId: 'run',
      sourceProviderTurnId: 'turn',
      sourceForkTurnId: 'message'
    })).toMatchObject({ providerId: 'pi', agentProfileId: 'pi:default' })
    expect(() => normalizeAgentForkSessionRequest({
      providerId: 'pi',
      sourceSessionId: 'session',
      sourceRunId: 'run',
      sourceProviderTurnId: 'turn',
      sourceForkTurnId: 'message'
    })).toThrow('agentProfileId')
  })

  it('normalizes a stopped first-turn restart without inventing native boundaries', () => {
    expect(normalizeAgentStartRequest({
      prompt: 'edited',
      providerId: 'qoder',
      expectedExternalSessionId: 'run-stopped',
      restartLastTurn: { replaceRunId: ' run-stopped ' }
    })).toMatchObject({
      expectedExternalSessionId: 'run-stopped',
      restartLastTurn: { replaceRunId: 'run-stopped' }
    })
    expect(() => normalizeAgentStartRequest({
      prompt: 'edited',
      providerId: 'qoder',
      restartLastTurn: { replaceRunId: 'run-stopped' }
    })).toThrow('可信会话或 run 边界')
    expect(() => normalizeAgentStartRequest({
      prompt: 'edited',
      providerId: 'qoder',
      expectedExternalSessionId: 'run-stopped',
      restartLastTurn: { replaceRunId: 'run-stopped' },
      forkLastTurn: {
        replaceRunId: 'run-stopped',
        replaceProviderTurnId: 'provider-turn',
        replaceForkTurnId: 'fork-turn'
      }
    })).toThrow('不能同时请求分支与重新开始')
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

  it('只在 Provider 真的给出理由时附带审批风险说明，并做脱敏与单行化', () => {
    const plain = agentPermissionQuestion('run-1', 'permission-1', '权限请求', '允许执行命令？', 'git status')
    expect(plain.questions[0].warning).toBeUndefined()

    const warned = agentPermissionQuestion(
      'run-1', 'permission-2', '权限请求', '允许执行命令？', 'curl ...',
      true, 'claude:permission:Bash', '允许这类操作直到当前原生会话结束',
      sanitizeApprovalWarning('\u001B[31mask rule matched\u001B[0m\n  api_key="sk-live-123"')
    )
    expect(warned.questions[0].warning).toBe('ask rule matched api_key=«REDACTED»')

    expect(sanitizeApprovalWarning(undefined)).toBeUndefined()
    expect(sanitizeApprovalWarning('   ')).toBeUndefined()
    expect(sanitizeApprovalWarning('a'.repeat(500))).toHaveLength(400)
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

  it('keeps a Pi custom launcher identity separate from its provider and transport', () => {
    expect(normalizeAgentStartRequest({
      prompt: 'hi',
      agentId: 'pi:0123456789abcdef',
      permissionMode: 'full_access'
    })).toMatchObject({
      providerId: 'pi',
      agentId: 'pi:0123456789abcdef',
      agentProfileId: 'pi:0123456789abcdef',
      runtimeProvider: 'pi_rpc'
    })
    expect(() => normalizeAgentStartRequest({ prompt: 'hi', providerId: 'pi' })).toThrow('agentProfileId')
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

  it('preserves Base64 alphabet, padding and whitespace validation under byte mutations', () => {
    // Independent grammar oracle uses tiny inputs only; quantified regexps are
    // unsuitable for the large-image production path.
    const reference = (value: string): number | null => {
      const compact = value.replace(/\s+/g, '')
      if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null
      return compact.length / 4 * 3 - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0)
    }
    for (const seed of ['QUJD', 'QUE=', 'QQ==', '====', 'A===', 'A=AA', 'Q U J D']) {
      for (let index = 0; index < seed.length; index++) {
        for (let code = 0; code < 256; code++) {
          const value = seed.slice(0, index) + String.fromCharCode(code) + seed.slice(index + 1)
          expect(decodedBase64ByteLength(value)).toBe(reference(value))
        }
      }
    }
    for (const value of ['', '\uFEFFQUJD\n', 'QU\u200bJD', 'QU\ud800JD']) {
      expect(decodedBase64ByteLength(value)).toBe(reference(value))
    }
  })

  it('accepts images beyond the former per-image, aggregate and count limits', () => {
    const tenMiB = Buffer.alloc(10 * 1024 * 1024).toString('base64')
    const overTenMiB = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')
    const large = normalizeAgentStartRequest({
      prompt: '',
      attachments: [{ kind: 'image', name: 'large.png', mimeType: 'image/png', dataBase64: overTenMiB }]
    }).attachments
    expect(large).toHaveLength(1)
    expect(large[0].dataBase64).toBe(overTenMiB)
    expect(large[0].size).toBe(10 * 1024 * 1024 + 1)
    expect(decodedBase64ByteLength(overTenMiB.slice(0, -4) + 'AA!A')).toBeNull()
    expect(() => normalizeAgentStartRequest({
      prompt: '',
      attachments: Array.from({ length: 9 }, (_, index) => ({
        kind: 'image' as const,
        name: `${index}.png`,
        mimeType: 'image/png' as const,
        dataBase64: tenMiB
      }))
    })).not.toThrow()
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

  it('preserves bounded native long-option and multiline editor requests', () => {
    const options = Array.from({ length: 20 }, (_, index) => ({ label: `选项 ${index}`, description: `说明 ${index}` }))
    const request = normalizeAgentQuestionRequest('run-native', 'native-1', {
      questions: [{ question: '原生选择', header: '选择', options, multiSelect: false }]
    }, undefined, 'native', true)
    expect(request?.questions[0].options).toHaveLength(20)

    const editor = normalizeAgentQuestionRequest('run-native', 'native-editor', {
      questions: [{ question: '正文', header: '编辑器', options: [], multiSelect: false, inputMode: 'multiline', initialValue: 'Existing\nobjective' }]
    }, undefined, 'native', true)!
    expect(editor.questions[0].inputMode).toBe('multiline')
    expect(editor.questions[0].initialValue).toBe('Existing\nobjective')
    expect(normalizeAgentQuestionRequest('run-native', 'oversized-editor', {
      questions: [{ ...editor.questions[0], initialValue: 'x'.repeat(100_001) }]
    }, undefined, 'native', true)).toBeNull()
    expect(normalizeAgentQuestionResponse(editor, {
      runId: 'run-native', questionId: 'native-editor', behavior: 'answered', answers: { 正文: 'x'.repeat(50_000) }
    })).not.toBeNull()
  })

  it('preserves explicit Pi custom-answer intent without opening other closed-choice contracts', () => {
    const normalized = normalizeAgentQuestionRequest('run-native', 'select-1', {
      questions: [{ question: 'Continue?', header: 'Next', options: [{ label: 'Continue', description: 'Continue' }], multiSelect: false }]
    }, undefined, 'pi_extension_ui:select', true)!
    const request = { ...normalized, providerId: 'pi' as const }
    const response = {
      runId: request.runId, questionId: request.questionId, behavior: 'answered',
      answers: { 'Continue?': 'Continue' }, nativeCustomAnswer: true
    }
    expect(normalizeAgentQuestionResponse(request, response)).toEqual(response)
    for (const unrelated of [
      { ...request, providerId: 'claude' as const },
      { ...request, source: 'pi_extension_ui:confirm' },
      { ...request, questions: [{ ...request.questions[0], allowCustomAnswer: false }] },
      { ...request, questions: [...request.questions, { ...request.questions[0], question: 'Second?' }] }
    ]) expect(normalizeAgentQuestionResponse(unrelated, response)).toBeNull()
    expect(normalizeAgentQuestionResponse(request, { ...response, nativeCustomAnswer: false })).toBeNull()
  })

  it('validates per-question custom intent only for a Pi questionnaire', () => {
    const request = {
      ...normalizeAgentQuestionRequest('run', 'tool', { questions: [
        { header: 'First', question: 'First?', options: [{ label: 'A', description: 'Alpha' }, { label: 'B', description: 'Beta' }] },
        { header: 'Second', question: 'Second?', options: [{ label: 'C', description: 'Gamma' }, { label: 'D', description: 'Delta' }] }
      ] }, undefined, 'pi_questionnaire')!,
      providerId: 'pi' as const
    }
    const response = { runId: 'run', questionId: 'tool', behavior: 'answered', answers: { 'First?': '1', 'Second?': '2' }, nativeCustomAnswers: ['First?'] }
    expect(normalizeAgentQuestionResponse(request, response)).toEqual(response)
    for (const nativeCustomAnswers of [true, ['Missing?'], [1], ['First?', 'Second?', 'Third?']]) {
      expect(normalizeAgentQuestionResponse(request, { ...response, nativeCustomAnswers })).toBeNull()
    }
    expect(normalizeAgentQuestionResponse({ ...request, providerId: 'claude' }, response)).toBeNull()
    expect(normalizeAgentQuestionResponse({ ...request, source: 'pi_extension_ui:select' }, response)).toBeNull()
    expect(normalizeAgentQuestionResponse({ ...request, questions: request.questions.map((question) => ({ ...question, allowCustomAnswer: false })) }, response)).toBeNull()
    expect(normalizeAgentQuestionResponse(request, { ...response, answers: { 'First?': '1' } })).toBeNull()
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
