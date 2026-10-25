import * as shared from './shared'
const { describe, it, expect, renderWelcome } = shared
type Turn = shared.Turn

describe('ChatView 隐藏常驻来源说明', () => {
  const turns: Turn[] = [{ runId: 'copy-cleanup', userText: 'question', items: [], done: true }]

  it.each([false, true])('正常会话不显示来源横条或 runtime 脚注（remote=%s）', (remote) => {
    const html = renderWelcome({ turns, remoteHost: remote ? 'fixture-host' : undefined })
    expect(html).not.toContain('chat-evidence-source')
    expect(html).not.toContain('本机真实会话')
    expect(html).not.toContain('runtime /')
    expect(html).not.toContain('未捕获字段保持未知')
  })

  it('缓存首帧保留内容且立即锁定操作，加载文案由原生计时检查覆盖', () => {
    const html = renderWelcome({ turns, input: '缓存待核对的草稿', sessionLoading: true, sessionCacheVisible: true, hasSelectedSession: true })
    expect(html).toContain('aria-busy="true"')
    expect(html).toMatch(/class="send"[^>]*disabled=""/)
    expect(html).toContain('transcript-turn')
    expect(html).not.toContain('data-status="loading"')
    expect(html).not.toContain('data-loading-previous="true"')
  })
})