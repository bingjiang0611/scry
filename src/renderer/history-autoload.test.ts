import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCssManifest } from './css-test-reader'
import { HISTORY_AUTOLOAD_THRESHOLD_PX, isViewportShort, shouldLoadOlder } from './history-autoload'

const css = readCssManifest(join(__dirname, 'styles.css'))

describe('时间线自动续读的触发条件', () => {
  const base = { scrollTop: 900, hasOlder: true, loading: false, viewportShort: false }

  it('滚到预取距离内才取页，不等到贴住顶部', () => {
    expect(shouldLoadOlder(base)).toBe(false)
    expect(shouldLoadOlder({ ...base, scrollTop: HISTORY_AUTOLOAD_THRESHOLD_PX })).toBe(true)
    expect(shouldLoadOlder({ ...base, scrollTop: 0 })).toBe(true)
  })

  it('没有更早轮次时不请求', () => {
    expect(shouldLoadOlder({ ...base, scrollTop: 0, hasOlder: false })).toBe(false)
  })

  it('一页在途时不重复请求（滚动事件会连续触发）', () => {
    expect(shouldLoadOlder({ ...base, scrollTop: 0, loading: true })).toBe(false)
  })

  it('内容不足一屏时没有滚动事件可等，允许主动补页', () => {
    expect(shouldLoadOlder({ ...base, scrollTop: 5000, viewportShort: true })).toBe(true)
  })

  it('判定内容不足一屏时留出预取距离，不要求精确相等', () => {
    expect(isViewportShort(400, 400)).toBe(true)
    expect(isViewportShort(400 + HISTORY_AUTOLOAD_THRESHOLD_PX, 400)).toBe(true)
    expect(isViewportShort(400 + HISTORY_AUTOLOAD_THRESHOLD_PX + 1, 400)).toBe(false)
  })
})

describe('续读依赖的滚动锚定合同', () => {
  it('时间线容器保持 overflow-anchor: none，位移只由 hook 补偿', () => {
    // 开启浏览器锚定会与本 hook 的显式补偿叠加；关闭后补偿才是唯一来源，且与
    // 会话切换时的显式定位策略一致。改动这一行前先改补偿逻辑。
    const index = css.indexOf('\n.chat {')
    expect(index, 'missing .chat rule').toBeGreaterThan(-1)
    const body = css.slice(css.indexOf('{', index) + 1, css.indexOf('}', css.indexOf('{', index)))
    expect(body).toContain('overflow-anchor: none')
  })
})
