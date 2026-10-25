import * as shared from './shared'
const { describe, it, expect, formatElapsedMs } = shared

describe('formatElapsedMs', () => {
  it('分钟级：MM:SS 补零', () => {
    expect(formatElapsedMs(12 * 60 * 1000 + 34 * 1000)).toBe('12:34')
    expect(formatElapsedMs(0)).toBe('00:00')
  })

  it('小时级：H:MM:SS', () => {
    expect(formatElapsedMs((3 * 3600 + 5 * 60 + 9) * 1000)).toBe('3:05:09')
  })
})