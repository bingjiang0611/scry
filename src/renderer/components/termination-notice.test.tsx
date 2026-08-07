import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TerminationNotice } from './ChatTurn'

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
})
