import * as shared from './shared'
const { describe, it, expect, composerPromptHistory, navigateComposerHistory } = shared
type Turn = shared.Turn

describe('composer prompt history', () => {
  const history = ['第一条输入', '第二条输入', '第三条输入']

  it('starts from the newest prompt only when the composer is empty', () => {
    expect(navigateComposerHistory(history, '', null, 'older')).toEqual({ position: 2, value: '第三条输入' })
    expect(navigateComposerHistory(history, '正在编辑', null, 'older')).toBeNull()
    expect(navigateComposerHistory(history, '', null, 'newer')).toBeNull()
  })

  it('moves backward and forward without wrapping, then restores the empty draft', () => {
    expect(navigateComposerHistory(history, '第三条输入', 2, 'older')).toEqual({ position: 1, value: '第二条输入' })
    expect(navigateComposerHistory(history, '第一条输入', 0, 'older')).toEqual({ position: 0, value: '第一条输入' })
    expect(navigateComposerHistory(history, '第二条输入', 1, 'newer')).toEqual({ position: 2, value: '第三条输入' })
    expect(navigateComposerHistory(history, '第三条输入', 2, 'newer')).toEqual({ position: null, value: '' })
  })

  it('includes queued inputs and removes only adjacent duplicate or empty entries', () => {
    const turns: Turn[] = [
      { runId: 'one', userText: '已发送', items: [], done: true },
      { runId: 'two', userText: '已发送', items: [], done: true },
      { runId: 'empty', userText: '  ', items: [], done: true }
    ]
    const queued = [{ messageId: 'queued-history', text: '等待发送', attachments: [], request: {} }]
    expect(composerPromptHistory(turns, queued)).toEqual(['已发送', '等待发送'])
  })
})