import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantTurn, TerminationNotice, ToolTerminationNotice } from './ChatTurn'

describe('termination notice', () => {
  it('shows an actionable warning for successful but incomplete output', () => {
    const html = renderToStaticMarkup(<TerminationNotice reason="output_token_limit" />)
    expect(html).toContain('role="status"')
    expect(html).toContain('输出已截断')
    expect(html).toContain('继续生成')
  })

  it('does not render failure reasons that use the existing error card', () => {
    expect(renderToStaticMarkup(<TerminationNotice reason="input_context_overflow" />)).toBe('')
  })

  it('shows the actual tool boundary without claiming Goal approval or advising resume', () => {
    const message = 'Previous completion review is unresolved. It will not be replayed, including after resume. Completion remains unverified.'
    const html = renderToStaticMarkup(<AssistantTurn
      turn={{ runId: 'pi-goal', userText: '/goal resume', done: true, items: [{
        id: 'result', runId: 'pi-goal', ts: '2026-09-20T15:49:38Z', kind: 'harness', stage: 'result',
        providerId: 'pi', isError: false, providerStopReason: 'toolUse',
        toolTermination: { tool: 'goal_complete', message }
      }] }}
      selectedId={null} onSelect={() => {}}
    />)
    expect(html).toContain('工具已结束本次执行')
    expect(html).toContain(message)
    expect(html).toContain('执行结束不代表目标已验证完成')
    expect(html).not.toContain('继续当前会话重试')
    expect(html).not.toContain('errline')
  })

  it('renders tool text as untrusted plain text and keeps missing explanations explicit', () => {
    expect(renderToStaticMarkup(<ToolTerminationNotice evidence={{ tool: 'goal_complete', message: '<script>bad()</script>' }} />))
      .toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(renderToStaticMarkup(<ToolTerminationNotice evidence={{ tool: 'custom', message: '' }} />))
      .toContain('工具未提供结束说明')
  })
})
