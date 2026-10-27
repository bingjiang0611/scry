import * as shared from './shared'
const { describe, it, expect, sessionEvidenceGapAfterLoad, renderWelcome } = shared
type ParsedTurn = shared.ParsedTurn

describe('选中的历史会话读不到证据时不假装成新会话', () => {
  it('page 为 null 与归档空轮次分开定义，有轮次时不报缺失', () => {
    expect(sessionEvidenceGapAfterLoad('s1', null)).toEqual({
      sessionId: 's1',
      status: 'unavailable',
      detail: '本机没有命中这条会话的可读证据：Provider transcript 与 Scry 归档都没有记录。'
    })
    expect(sessionEvidenceGapAfterLoad('s1', { turns: [] })).toMatchObject({ status: 'empty' })
    expect(sessionEvidenceGapAfterLoad('s1', {
      turns: [{ runId: 'run-1', userText: 'hi', done: true, items: [] } as unknown as ParsedTurn]
    })).toBeNull()
  })

  it('证据缺失时渲染说实话的空态，而不是“开始一次可追溯执行” hero', () => {
    const html = renderWelcome({
      cwd: '/tmp/project',
      sessionEvidenceGap: {
        status: 'unavailable',
        detail: '本机没有命中这条会话的可读证据：Provider transcript 与 Scry 归档都没有记录。'
      }
    })

    expect(html).toContain('chat-session-evidence-gap')
    expect(html).toContain('data-status="unavailable"')
    expect(html).toContain('这条会话没有可读的本机证据')
    expect(html).toContain('Provider transcript 与 Scry 归档都没有记录')
    expect(html).not.toContain('开始一次可追溯执行')
    expect(html).not.toContain('新会话 · 本机证据')
  })

  it('正在加载选中的历史时只标 busy，不展示加载提示、空归档或上一次错误', () => {
    const html = renderWelcome({
      cwd: '/tmp/project',
      hasSelectedSession: true,
      sessionLoading: true,
      sessionEvidenceGap: { status: 'error', detail: 'previous failure' }
    })

    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('data-status="loading"')
    expect(html).not.toContain('正在加载会话历史')
    expect(html).not.toContain('这条会话暂时没有可显示的轮次')
    expect(html).not.toContain('previous failure')
    expect(html).not.toContain('welcome-hero-icon')
  })

  it('加载失败不声称历史为空，并告诉用户如何重新加载', () => {
    const html = renderWelcome({
      cwd: '/tmp/project',
      hasSelectedSession: true,
      sessionEvidenceGap: { status: 'error', detail: '无法加载会话历史：workspace changed' }
    })

    expect(html).toContain('会话历史加载失败')
    expect(html).toContain('重新点击侧边栏中的会话加载')
    expect(html).not.toContain('这条会话的归档里没有轮次')
    expect(html).not.toContain('没有可读的本机证据')
    expect(html).not.toContain('正在等待本机归档')
    expect(html).not.toContain('welcome-hero-icon')
  })

  it('归档命中但没有轮次时用另一句文案，仍不渲染 hero', () => {
    const html = renderWelcome({
      cwd: '/tmp/project',
      sessionEvidenceGap: { status: 'empty', detail: '归档已命中，但里面没有任何已收口的轮次。' }
    })

    expect(html).toContain('data-status="empty"')
    expect(html).toContain('这条会话的归档里没有轮次')
    expect(html).not.toContain('开始一次可追溯执行')
  })

  it('已选中的会话即使轮次尚未恢复，也不会退回新会话 hero', () => {
    const html = renderWelcome({
      cwd: '/tmp/project',
      agentLocked: true,
      hasSelectedSession: true
    })

    expect(html).toContain('这条会话暂时没有可显示的轮次')
    expect(html).toContain('不会将它当作新会话')
    expect(html).not.toContain('今天想在')
    expect(html).not.toContain('welcome-hero-icon')
  })

  it('真正的新会话（无证据缺失）仍然渲染简洁 hero', () => {
    const html = renderWelcome({ cwd: '/tmp/project' })

    expect(html).toContain('今天想在 <span>project</span> 中构建什么？')
    expect(html).toContain('welcome-hero-icon')
    expect(html).not.toContain('chat-session-evidence-gap')
  })
})