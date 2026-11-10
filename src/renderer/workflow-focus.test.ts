import { describe, expect, it } from 'vitest'
import { requestWorkflowRun, subscribeWorkflowRunRequest, takeWorkflowRunRequest, workflowRunRequest } from './workflow-focus'

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

  it('请求只生效一次，之后的流式更新不能覆盖用户手动选的运行', () => {
    const first = { id: 'run-a', toolUseId: 'toolu_a' }
    const second = { id: 'run-b', toolUseId: 'toolu_b' }
    requestWorkflowRun('toolu_a')
    expect(takeWorkflowRunRequest([first, second])).toBe(first)
    expect(workflowRunRequest()).toBeNull()
    // The surface re-runs its effect on every streamed update; nothing may be re-applied.
    expect(takeWorkflowRunRequest([first, second])).toBeUndefined()
  })

  it('请求的运行尚未加载时保持等待，加载后再生效', () => {
    const later = { id: 'run-c', toolUseId: 'toolu_c' }
    requestWorkflowRun('toolu_c')
    expect(takeWorkflowRunRequest([])).toBeUndefined()
    expect(workflowRunRequest()).toBe('toolu_c')
    expect(takeWorkflowRunRequest([later])).toBe(later)
    expect(workflowRunRequest()).toBeNull()
  })
})
