import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantTurn, SteerEvidenceMessage } from './components/ChatTurn'
import { ComposerQueue } from './components/chat-view/ComposerQueue'
import { latestSteerEvidenceForTurns } from './steer'
import { QUEUE_COPY } from './constants/copy'

describe('Steer renderer evidence', () => {
  it.each([
    { done: false, busy: false, inFlight: false, removable: false },
    { done: true, busy: false, inFlight: false, removable: true },
    { done: true, busy: true, inFlight: false, removable: true },
    { done: true, busy: false, inFlight: true, removable: false }
  ])('gates unknown queue dismissal on its own terminal receipt: %j', ({ done, busy, inFlight, removable }) => {
    const evidence = {
      messageId: 'unknown', prompt: 'follow up', attachments: [], status: 'unknown' as const, message: 'IPC timeout'
    }
    const html = renderToStaticMarkup(<ComposerQueue
      queuedPrompts={[{ messageId: 'unknown', text: 'follow up', attachments: [], request: { providerId: 'pi' }, steer: { status: 'unknown' } }]}
      steerEvidenceByMessageId={latestSteerEvidenceForTurns([{
        done, items: [{ id: 'receipt', ts: '1', runId: 'run', kind: 'human', stage: 'steer', steer: evidence }]
      }])}
      steerInFlightMessageIds={new Set(inFlight ? ['unknown'] : [])}
      onRemoveQueuedPrompt={() => {}}
      onSteerQueuedPrompt={() => {}}
      onEditQueuedPrompt={() => {}}
      input="" draftAttachments={[]} nextQueuedMessageId="unknown" busy={busy}
    />)
    const remove = html.match(/<button[^>]*class="queue-remove"[^>]*>/)?.[0]
    expect(remove).toBeDefined()
    expect(remove?.includes('disabled')).toBe(!removable)
    expect(html.match(/<button[^>]*class="queue-steer"[^>]*>/)?.[0]).toContain('disabled')
    expect(html.match(/<button[^>]*class="queue-edit"[^>]*>/)?.[0]).toContain('disabled')
    if (done) expect(remove).toContain(QUEUE_COPY.dismissUnknown)
    expect(evidence.status).toBe('unknown')
  })

  it('corrects the retry hint on existing account-binding failures without rewriting the archived turn', () => {
    const turn = {
      runId: 'old-run', userText: 'continue', done: true, items: [],
      error: 'Qoder: account_changed_start_new_session',
      errorHint: '继续当前会话重试；若再次中止，请检查上游 Provider 状态与 Rotom 日志'
    }
    const html = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)
    expect(html).toContain('请新建会话')
    expect(html).not.toContain('继续当前会话重试')
    expect(html).toContain(turn.error)
    expect(turn.errorHint).toContain('继续当前会话重试')
  })

  it.each([false, true])('preserves account and transport recovery for old/new hints: %s', current => {
    const accountHint = 'Qoder 登录身份与会话绑定不一致。请新建会话后发送；在当前会话重试不会解除绑定。'
    const transportHint = '检查上游服务或代理是否同时支持 WebSocket 与 SSE'
    const turn = { runId: 'old-run', userText: 'continue', done: true, items: [],
      error: 'Qoder: account_changed_start_new_session (WebSocket error)',
      errorHint: current ? `${accountHint} ${transportHint}` : transportHint }
    const html = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)
    expect(html).toContain('请新建会话')
    expect(html).toContain(transportHint)
  })

  it('does not replace input-overflow recovery with an account hint', () => {
    const hint = '从失败处恢复：移除或压缩大图'
    const turn = { runId: 'old-run', userText: 'continue', done: true, items: [],
      error: 'Qoder: http_413 account_changed_start_new_session', errorHint: hint }
    const html = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)
    expect(html).toContain(hint)
    expect(html).not.toContain('当前会话重试不会解除绑定')
  })

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
