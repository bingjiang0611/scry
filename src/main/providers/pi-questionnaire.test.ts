import { describe, expect, it, vi } from 'vitest'
import { PiQuestionnaire } from './pi-questionnaire'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../../shared/runtime'

const questionnaireInput = { questions: [
  { header: 'Goal', question: 'What matters?', multiSelect: false, options: [
    { label: 'Control', description: 'Stay in control', preview: 'Details' },
    { label: 'Speed', description: 'Finish sooner' }
  ] },
  { header: 'Scope', question: 'Which parts?', multiSelect: true, options: [
    { label: 'UI', description: 'Interface' },
    { label: 'Core', description: 'Runtime' }
  ] },
  { header: 'Review', question: 'When to review?', multiSelect: false, options: [
    { label: 'Now', description: 'Before continuing' },
    { label: 'Later', description: 'At the end' }
  ] }
] }

const first = { id: 'first', method: 'select', title: '[Goal] What matters?\n\n--- 1. Control preview ---\nDetails', options: ['1. Control — Stay in control', '2. Speed — Finish sooner', '3. Type something.'] }
const second = { id: 'second', method: 'input', title: '[Scope] Which parts?\n\n1. UI — Interface\n2. Core — Runtime\n\nEnter numbers', placeholder: '1,3' }
const third = { id: 'third', method: 'select', title: '[Review] When to review?', options: ['1. Now — Before continuing', '2. Later — At the end', '3. Type something.'] }

function setup(custom = false) {
  const group = PiQuestionnaire.fromTool('run', 'tool', questionnaireInput)!
  const response: AgentQuestionResponse = { runId: 'run', questionId: 'tool', behavior: 'answered', answers: {
    'What matters?': '2', 'Which parts?': '1,2', 'When to review?': custom ? '1' : '2'
  }, nativeCustomAnswers: custom ? ['When to review?'] : [] }
  const ask = vi.fn(async () => response)
  return { group, ask }
}

describe('Pi grouped questionnaire', () => {
  it('waits for a full review, then replays final choices in native order with one user request', async () => {
    const { group } = setup()
    let finish!: (response: AgentQuestionResponse) => void
    const ask = vi.fn((_request: AgentQuestionRequest) => new Promise<AgentQuestionResponse>((resolve) => { finish = resolve }))
    expect(group.matches(first)).toBe(true)
    let sent = false
    const pending = group.reply(first, ask).then((reply) => { sent = true; return reply })
    await Promise.resolve()
    expect(sent).toBe(false)
    expect(ask.mock.calls[0][0]).toMatchObject({ questionId: 'tool', providerId: 'pi', questions: questionnaireInput.questions })
    finish({ runId: 'run', questionId: 'tool', behavior: 'answered', answers: {
      'What matters?': '2', 'Which parts?': '1,2', 'When to review?': '2'
    } })
    expect(await pending).toEqual({ type: 'extension_ui_response', id: 'first', value: '2. Speed — Finish sooner' })
    expect(group.matches(second)).toBe(true)
    expect(await group.reply(second, ask)).toMatchObject({ id: 'second', value: '1,2' })
    expect(group.matches(third)).toBe(true)
    expect(await group.reply(third, ask)).toMatchObject({ id: 'third', value: '2. Later — At the end' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(group.matches(first)).toBe(false)
  })

  it('preserves custom text even when it equals an option index', async () => {
    const { group, ask } = setup(true)
    await group.reply(first, ask)
    await group.reply(second, ask)
    expect(await group.reply(third, ask)).toMatchObject({ value: '3. Type something.' })
    const input = { id: 'custom', method: 'input', title: '[Review] When to review?\n\nType your answer:' }
    expect(group.matches({ ...input, title: '[Other] When to review?\n\nType your answer:' })).toBe(false)
    expect(group.matches(input)).toBe(true)
    expect(await group.reply(input, ask)).toEqual({ type: 'extension_ui_response', id: 'custom', value: '1' })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('cancels without sending any partial answer', async () => {
    const { group } = setup()
    expect(await group.reply(first, async () => ({ runId: 'run', questionId: 'tool', behavior: 'cancelled' })))
      .toEqual({ type: 'extension_ui_response', id: 'first', cancelled: true })
  })

  it('does not match unrelated, reordered or changed native prompts', async () => {
    const { group, ask } = setup()
    expect(group.matches(second)).toBe(false)
    expect(group.matches({ ...first, options: [...first.options].reverse() })).toBe(false)
    expect(group.matches({ ...first, title: '[Goal] Different question' })).toBe(false)
    await group.reply(first, ask)
    expect(group.matches({ ...second, title: second.title.replace('Interface', 'Changed') })).toBe(false)
    expect(group.matches(first)).toBe(false)
  })

  it('leaves single questions and invalid payloads on the existing native path', () => {
    expect(PiQuestionnaire.fromTool('run', 'tool', { questions: [questionnaireInput.questions[0]] })).toBeNull()
    expect(PiQuestionnaire.fromTool('run', 'tool', { questions: [questionnaireInput.questions[0], questionnaireInput.questions[0]] })).toBeNull()
    expect(PiQuestionnaire.fromTool('run', 'tool', {})).toBeNull()
  })
})
