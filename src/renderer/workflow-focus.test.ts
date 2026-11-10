import { describe, expect, it } from 'vitest'
import { requestWorkflowRun, subscribeWorkflowRunRequest, workflowRunRequest } from './workflow-focus'

describe('workflow run focus request', () => {
  it('记住最近的请求，并允许清空', () => {
    requestWorkflowRun('toolu_a')
    expect(workflowRunRequest()).toBe('toolu_a')
    requestWorkflowRun(undefined)
    expect(workflowRunRequest()).toBeNull()
  })

  it('通知订阅者，取消订阅后不再收到', () => {
    requestWorkflowRun(undefined)
    const seen: Array<string | null> = []
    const unsubscribe = subscribeWorkflowRunRequest(() => seen.push(workflowRunRequest()))
    requestWorkflowRun('toolu_b')
    unsubscribe()
    requestWorkflowRun('toolu_c')
    expect(seen).toEqual(['toolu_b'])
    requestWorkflowRun(undefined)
  })
})
