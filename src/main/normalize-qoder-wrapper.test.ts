import { describe, it, expect } from 'vitest'
import { parseTranscriptToTurns, type NormalizeCtx } from './normalize.js'

function ctx(): NormalizeCtx {
  let n = 0
  return { runId: 'run-1', newId: () => `ev-${n++}`, now: () => '2026-06-23T00:00:00.000Z' }
}

describe('Qoder command wrapper transcript identity', () => {
  it('Qoder command wrapper 从带身份的 meta skill 注入承接首轮身份，下一轮保持独立', () => {
    const command = '<command-name>/rate-native</command-name><command-args>42</command-args>'
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: command } }),
      JSON.stringify({
        type: 'user', isMeta: true, promptId: 'prompt-1', requestSetId: 'request-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /tmp/commands' }] }
      }),
      JSON.stringify({
        type: 'assistant', promptId: 'prompt-1',
        message: { content: [{ type: 'text', text: 'first answer' }], stop_reason: 'end_turn' }
      }),
      JSON.stringify({
        type: 'user', promptId: 'prompt-2', requestSetId: 'request-2',
        message: { role: 'user', content: 'next prompt' }
      }),
      JSON.stringify({
        type: 'assistant', promptId: 'prompt-2',
        message: { content: [{ type: 'text', text: 'next answer' }], stop_reason: 'end_turn' }
      })
    ].join('\n')

    const turns = parseTranscriptToTurns(content, ctx())

    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      userText: command,
      providerTurnId: 'prompt-1',
      requestSetId: 'request-1',
      stopReason: 'end_turn'
    })
    expect(turns[1]).toMatchObject({
      userText: 'next prompt',
      providerTurnId: 'prompt-2',
      requestSetId: 'request-2',
      stopReason: 'end_turn'
    })
  })

  it('Qoder command wrapper 的冲突身份不覆盖原值，并保持精确选择不可用', () => {
    const turns = parseTranscriptToTurns([
      JSON.stringify({
        type: 'user', promptId: 'wrapper-prompt', requestSetId: 'wrapper-request',
        message: { role: 'user', content: '<command-name>/rate-native</command-name><command-args>43</command-args>' }
      }),
      JSON.stringify({
        type: 'user', isMeta: true, promptId: 'injected-prompt', requestSetId: 'injected-request',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /tmp/commands' }] }
      })
    ].join('\n'), ctx())

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      providerTurnId: 'wrapper-prompt',
      requestSetId: 'wrapper-request',
      identityContradictory: true
    })
  })

  it('普通用户粘贴 skill 头不会提升原轮身份，但仍保留 skill 展示事件', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<command-name>/rate-native</command-name><command-args>42</command-args>' }
      }),
      JSON.stringify({
        type: 'user',
        promptId: 'pasted-prompt',
        requestSetId: 'pasted-request',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /tmp/pasted' }] }
      })
    ].join('\n')
    const turns = parseTranscriptToTurns(content, ctx())

    expect(turns).toHaveLength(1)
    expect(turns[0]).not.toHaveProperty('providerTurnId')
    expect(turns[0]).not.toHaveProperty('requestSetId')
    expect(turns[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', name: 'pasted' })
    ]))
  })

  it.each([
    ['isReplay', { isReplay: true }],
    ['isSidechain', { isSidechain: true }],
    ['isSynthetic', { isSynthetic: true }],
    ['parent_tool_use_id', { parent_tool_use_id: 'tool-1' }],
    ['forkedFrom', { forkedFrom: 'turn-1' }]
  ])('meta skill identity remains excluded for %s', (_name, excluded) => {
    const turns = parseTranscriptToTurns([
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<command-name>/rate-native</command-name><command-args>42</command-args>' }
      }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        promptId: 'excluded-prompt',
        requestSetId: 'excluded-request',
        ...excluded,
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /tmp/excluded' }] }
      })
    ].join('\n'), ctx())

    expect(turns).toHaveLength(1)
    expect(turns[0]).not.toHaveProperty('providerTurnId')
    expect(turns[0]).not.toHaveProperty('requestSetId')
  })

})
