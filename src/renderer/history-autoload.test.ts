import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCssManifest } from './css-test-reader'
import {
  HISTORY_AUTOLOAD_THRESHOLD_PX,
  canFill,
  initialFillRetryState,
  isViewportShort,
  settleFillRetry,
  shouldLoadOlder
} from './history-autoload'

const css = readCssManifest(join(__dirname, 'styles.css'))

it('时间线容器声明自动续读能力', () => {
  // 性能基准用这个无条件属性区分「滚到顶自动取页」与「点按钮取页」两种构建；
  // 用条件渲染的提示行判断会在历史取尽后丢失，把新构建误判成旧构建。
  const source = readFileSync(join(__dirname, 'components/ChatView.tsx'), 'utf8')
  expect(source).toContain('data-history-autoload="scroll"')
})

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

describe('主动补页失败后不自动重试', () => {
  it('在途请求不结算，仍允许结算后的下一次判断', () => {
    const pending = { pendingTurns: 10, blockedTurns: null }
    expect(settleFillRetry(pending, 20, true)).toBe(pending)
    expect(canFill(pending, 10)).toBe(false)
  })

  it('请求结束且轮次没增加时，同一批轮次不再自动补页', () => {
    // 短视口没有滚动事件可等：不阻断就会在 loading 回到 false 后立刻再发一次，持续失败即无限重试。
    const failed = settleFillRetry({ pendingTurns: 10, blockedTurns: null }, 10, false)
    expect(failed.blockedTurns).toBe(10)
    expect(canFill(failed, 10)).toBe(false)
  })

  it('补页成功或会话内容变化后重新允许自动补页', () => {
    const loaded = settleFillRetry({ pendingTurns: 10, blockedTurns: null }, 30, false)
    expect(loaded.blockedTurns).toBeNull()
    expect(canFill(loaded, 30)).toBe(true)
    const blocked = settleFillRetry({ pendingTurns: 10, blockedTurns: null }, 10, false)
    expect(canFill(blocked, 30)).toBe(true)
  })

  it('初始状态允许补页', () => {
    expect(canFill(initialFillRetryState, 10)).toBe(true)
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
