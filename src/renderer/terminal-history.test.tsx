import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TerminalHistory, terminalRecordingLabel } from './components/TerminalHistory'
import type { TerminalRecordingSummary } from '@shared/terminal'

describe('terminal history evidence', () => {
  it('does not present unknown termination or failed capture as a successful shell', () => {
    const item: TerminalRecordingSummary = { id: 'test', bytes: 0, active: false, state: 'interrupted' }
    expect(terminalRecordingLabel(item)).toContain('终态未确认')
    expect(terminalRecordingLabel({ ...item, state: 'failed' })).toContain('录制失败')
    expect(terminalRecordingLabel({ ...item, active: true, state: 'failed' })).toBe('Shell 运行中 · 录制失败')
    expect(terminalRecordingLabel({ ...item, state: 'complete' })).toBe('录制已结束')
  })
  it('reuses the accessible modal and exposes loading rather than an empty history before listing', () => {
    const html = renderToStaticMarkup(createElement(TerminalHistory, { cwd: '/repo', canOpen: true, onOpen: () => {}, onClose: () => {} }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('正在读取录制索引')
    expect(html).toContain('原文可能含密钥')
    expect(html).not.toContain('本页没有可列出的录制')
    expect(html).toContain('不恢复 Shell')
  })
})
