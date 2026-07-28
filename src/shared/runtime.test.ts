import { describe, expect, it } from 'vitest'
import {
  billingProviderForRuntime,
  normalizeAgentQuestionRequest,
  normalizeAgentQuestionResponse,
  normalizeAgentStartRequest,
  providerIdForRuntime,
  runtimeProviderForAgentId,
  runtimeProviderForProviderId
} from './runtime'

describe('runtime frontdoor mapping', () => {
  it('maps supported UI agents to runtime providers without falling back for unknown agents', () => {
    expect(runtimeProviderForAgentId('claude')).toBe('claude_sdk')
    expect(runtimeProviderForAgentId('codex')).toBe('codex_cli')
    expect(runtimeProviderForAgentId('qoder')).toBe('qoder_cli')
    expect(runtimeProviderForAgentId('opencode')).toBe('opencode_server')
    expect(runtimeProviderForAgentId('cursor')).toBeUndefined()
  })

  it('keeps runtime provider separate from billing provider', () => {
    expect(billingProviderForRuntime('claude_sdk')).toBe('anthropic')
    expect(billingProviderForRuntime('codex_cli')).toBe('codex')
    expect(billingProviderForRuntime('qoder_cli')).toBe('qoder')
    expect(billingProviderForRuntime('opencode_server')).toBeUndefined()
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
      attachments: []
    })
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
