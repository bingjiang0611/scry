import { describe, expect, it, vi } from 'vitest'
import type { AgentQuestionRequest } from '../shared/runtime'
import { UserQuestionBroker } from './user-question'

const request = (runId: string, questionId: string): AgentQuestionRequest => ({
  runId,
  questionId,
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
})

describe('UserQuestionBroker', () => {
  it('queues concurrent questions and settles the matching one only', async () => {
    const changes = vi.fn()
    const broker = new UserQuestionBroker(changes)
    const first = broker.request(request('run-1', 'tool-1'), new AbortController().signal)
    const second = broker.request(request('run-1', 'tool-2'), new AbortController().signal)

    expect(broker.list('run-1').map((item) => item.questionId)).toEqual(['tool-1', 'tool-2'])
    expect(broker.answer({ runId: 'run-1', questionId: 'missing', behavior: 'cancelled' })).toBe(false)
    expect(
      broker.answer({
        runId: 'run-1',
        questionId: 'tool-1',
        behavior: 'answered',
        answers: { '选择流程？': '全量' }
      })
    ).toBe(true)
    expect(await first).toMatchObject({ behavior: 'answered', answers: { '选择流程？': '全量' } })
    expect(broker.list('run-1').map((item) => item.questionId)).toEqual(['tool-2'])

    broker.cancelRun('run-1')
    expect(await second).toMatchObject({ behavior: 'cancelled' })
    expect(changes.mock.calls.map(([change]) => change.kind)).toEqual(['open', 'open', 'closed', 'closed'])
  })

  it('cancels a pending question when the SDK aborts its control request', async () => {
    const broker = new UserQuestionBroker(() => {})
    const controller = new AbortController()
    const pending = broker.request(request('run-1', 'tool-1'), controller.signal)

    controller.abort()

    expect(await pending).toEqual({ runId: 'run-1', questionId: 'tool-1', behavior: 'cancelled' })
    expect(broker.list('run-1')).toEqual([])
  })

  it('deduplicates a replayed request by run and toolUseID', () => {
    const broker = new UserQuestionBroker(() => {})
    const signal = new AbortController().signal
    expect(broker.request(request('run-1', 'tool-1'), signal)).toBe(broker.request(request('run-1', 'tool-1'), signal))
  })

  it('lets a duplicate SDK waiter abort without cancelling the original question', async () => {
    const broker = new UserQuestionBroker(() => {})
    const firstController = new AbortController()
    const duplicateController = new AbortController()
    const first = broker.request(request('run-1', 'tool-1'), firstController.signal)
    const duplicate = broker.request(request('run-1', 'tool-1'), duplicateController.signal)

    duplicateController.abort()
    expect(await duplicate).toMatchObject({ behavior: 'cancelled' })
    expect(broker.list('run-1')).toHaveLength(1)

    expect(
      broker.answer({
        runId: 'run-1',
        questionId: 'tool-1',
        behavior: 'answered',
        answers: { '选择流程？': '快速' }
      })
    ).toBe(true)
    expect(await first).toMatchObject({ behavior: 'answered', answers: { '选择流程？': '快速' } })
  })
})
