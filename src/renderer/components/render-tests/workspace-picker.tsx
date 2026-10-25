import type { ComponentProps } from 'react'
import * as shared from './shared'
const { describe, it, expect, ChatView, renderWelcome } = shared

describe('ChatView 项目选择条', () => {
  const hasPicker = (overrides: Partial<ComponentProps<typeof ChatView>> = {}) =>
    renderWelcome({ cwd: '/repo/rate-native', ...overrides }).includes('class="composer-context"')

  it('新建草稿即使已选项目仍可选择；未绑定项目保留入口', () => {
    expect(hasPicker()).toBe(true)
    expect(hasPicker({ cwd: null, agentLocked: true })).toBe(true)
  })

  it('新建会话立即显示项目选择，不等待 Provider 上下文重置', () => {
    expect(hasPicker({ sessionLoading: true, agentLocked: true, hasSelectedSession: false })).toBe(true)
    expect(hasPicker({ sessionLoading: true, agentLocked: true, hasSelectedSession: true })).toBe(false)
  })

  it.each([
    { submitting: true },
    { busy: true },
    { agentLocked: true },
    { sessionLoading: true, hasSelectedSession: true },
    { sessionEvidenceGap: { status: 'unavailable' as const, detail: '历史不可用' } },
    { turns: [{ runId: 'started', userText: '你好', done: false, items: [] }] },
    { turns: [{ runId: 'finished', userText: '你好', done: true, items: [] }] }
  ])('已绑定会话的启动/运行/恢复/完成状态不重复显示项目：%j', (state) => {
    expect(hasPicker(state)).toBe(false)
  })
})