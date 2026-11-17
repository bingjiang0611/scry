import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CountProgress, estimateRemainingMs, remainingLabel } from './CountProgress'

describe('estimateRemainingMs', () => {
  it('does not guess before there is a finished item and a second of data', () => {
    expect(estimateRemainingMs(0, 10, 5_000)).toBeNull()
    expect(estimateRemainingMs(3, 10, 900)).toBeNull()
    expect(remainingLabel(null)).toBe('正在估算…')
  })

  it('projects the observed rate onto what is left', () => {
    expect(estimateRemainingMs(2, 10, 2_000)).toBe(8_000)
    expect(remainingLabel(8_000)).toBe('约 8 秒')
    expect(remainingLabel(150_000)).toBe('约 3 分钟')
  })

  it('has nothing left once every item is handled', () => {
    expect(estimateRemainingMs(10, 10, 9_000)).toBeNull()
  })
})

describe('CountProgress', () => {
  it('shows the real count, failures, and an accessible determinate bar', () => {
    const html = renderToStaticMarkup(<CountProgress label="正在永久删除已存档会话" done={3} total={12} failed={1} />)
    expect(html).toContain('3 / 12')
    expect(html).toContain('1 个未删除')
    expect(html).toContain('正在估算…')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="3"')
    expect(html).toContain('aria-valuemax="12"')
    expect(html).toContain('scaleX(0.25)')
  })
})
