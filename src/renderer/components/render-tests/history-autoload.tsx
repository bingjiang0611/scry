import * as shared from './shared'
const { describe, it, expect, renderWelcome } = shared
type SessionHistoryWindow = NonNullable<Parameters<typeof renderWelcome>[0]>['historyWindow']

describe('时间线分页：一行元信息说明窗口，滚到顶自动续读', () => {
  const window = (overrides: Partial<NonNullable<SessionHistoryWindow>> = {}): NonNullable<SessionHistoryWindow> => ({
    sessionId: 's1',
    offset: 90,
    totalTurns: 120,
    hasOlder: true,
    completeness: 'complete',
    ...overrides
  })

  it('有更早轮次时只留一行说明与键盘按钮，不再占一整条卡片', () => {
    const html = renderWelcome({ historyWindow: window() })
    expect(html).toContain('history-window-note')
    expect(html).toContain('已加载 30 / 120 轮')
    expect(html).toContain('更早轮次仍在本机归档中，未丢弃')
    expect(html).toContain('加载更早轮次')
    expect(html).not.toContain('history-window-start')
    expect(html).not.toContain('history-window-loading')
  })

  it('取页在途只更新同一行状态，不插入任何会推动时间线的节点', () => {
    const html = renderWelcome({ historyWindow: window(), historyOlderLoading: true })
    expect(html).toContain('history-window-note')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('加载中…')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>加载中…<\/button>/)
    // 加载行会占位并推动正文，锚点补偿也因此无法精确；状态只留在头部一行。
    expect(html).not.toContain('history-window-loading')
    expect(html).not.toContain('正在加载更早轮次')
  })

  it('回到最早一轮后换成一条分隔说明，而不是继续显示可加载', () => {
    const html = renderWelcome({
      turns: [{ runId: 'run-1', userText: 'hi', done: true, items: [] }] as never,
      historyWindow: window({ offset: 0, hasOlder: false, pagedOlder: true })
    })
    expect(html).toContain('history-window-start')
    expect(html).toContain('已到最早一轮 · 共 120 轮')
    expect(html).not.toContain('history-window-note')
  })

  it('完整加载过的会话不显示到底分隔线（那会让人以为翻过页）', () => {
    const html = renderWelcome({
      turns: [{ runId: 'run-1', userText: 'hi', done: true, items: [] }] as never,
      historyWindow: window({ offset: 0, totalTurns: 30, hasOlder: false })
    })
    expect(html).not.toContain('history-window-start')
    expect(html).not.toContain('history-window-note')
  })

  it('远端归档保留来源说明，不把“未丢弃”换成另一台机器的本地措辞', () => {
    const html = renderWelcome({
      historyWindow: window({ totalTurns: 12 }),
      remoteHost: 'studio',
      turns: [
        { runId: 'run-1', userText: 'hi', done: true, items: [] },
        { runId: 'run-2', userText: 'again', done: true, items: [] }
      ] as never
    })
    expect(html).toContain('已加载最近 2 轮')
    expect(html).toContain('更早轮次仍在 studio 的归档中，未丢弃')
  })
})
