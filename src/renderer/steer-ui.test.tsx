import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantTurn, SteerEvidenceMessage } from './components/ChatTurn'

describe('Steer renderer evidence', () => {
  it('shows native acknowledgement and the original message without claiming model compliance', () => {
    const html = renderToStaticMarkup(
      <SteerEvidenceMessage evidence={{
        messageId: 'message-1',
        prompt: 'Use the smaller diff first',
        attachments: [],
        status: 'accepted'
      }} />
    )
    expect(html).toContain('Steer · Provider 已接收')
    expect(html).toContain('Use the smaller diff first')
    expect(html).toContain('原生回执不代表模型已读取或遵循')
    expect(html).not.toContain('模型已遵循')
  })

  it('renders only the latest lifecycle evidence for one message in a turn', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={{
          runId: 'run-1', userText: 'original', done: true,
          items: [
            { id: 'pending', ts: '1', runId: 'run-1', kind: 'human', stage: 'steer', steer: {
              messageId: 'message-3', prompt: 'follow up', attachments: [], status: 'pending'
            } },
            { id: 'accepted', ts: '2', runId: 'run-1', kind: 'human', stage: 'steer', steer: {
              messageId: 'message-3', prompt: 'follow up', attachments: [], status: 'accepted'
            } }
          ]
        }}
        selectedId={null}
        onSelect={() => {}}
      />
    )
    expect((html.match(/Steer ·/g) ?? []).length).toBe(1)
    expect(html).toContain('Provider 已接收')
    expect(html).not.toContain('提交中</b>')
  })

  it('keeps unknown evidence inspectable and explicit', () => {
    const html = renderToStaticMarkup(
      <SteerEvidenceMessage evidence={{
        messageId: 'message-2',
        prompt: 'Investigate the failing test',
        attachments: [],
        status: 'unknown',
        message: 'IPC timeout'
      }} />
    )
    expect(html).toContain('Steer · 结果未知')
    expect(html).toContain('IPC timeout')
  })
})
