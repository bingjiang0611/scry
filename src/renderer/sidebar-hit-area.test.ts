import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 会话行的操作区（···/置顶/存档）是绝对定位的兄弟节点，盖在会话按钮上方。
// 它自己不处理点击：一旦整块 pointer-events: auto，渐变遮罩的 padding 与图标之间的
// 间隙就变成盲区——点上去既进不了会话，也不触发任何操作。jsdom 不做布局，
// 所以这条不变式只能在样式源码上锁住。
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8')

function ruleBody(selector: string): string {
  const index = css.indexOf(`\n${selector} {`)
  expect(index, `missing CSS rule: ${selector}`).toBeGreaterThan(-1)
  const start = css.indexOf('{', index)
  const end = css.indexOf('}', start)
  return css.slice(start + 1, end)
}

describe('侧边栏会话行命中区域', () => {
  it('操作区容器始终不接指针事件', () => {
    expect(ruleBody('.sb-sess-acts')).toContain('pointer-events: none')
  })

  it('hover/focus 只让真正的操作按钮可点，容器本身不会变成可点盲区', () => {
    const hoverContainer = /\.sb-sess-row:(?:hover|focus-within) \.sb-sess-acts \{[^}]*\}/g
    for (const rule of css.match(hoverContainer) ?? []) {
      expect(rule).not.toContain('pointer-events')
    }
    expect(css).toMatch(
      /\.sb-sess-row:hover \.sb-sess-acts > \.sb-act,\s*\.sb-sess-row:focus-within \.sb-sess-acts > \.sb-act \{\s*pointer-events: auto;/
    )
  })
})
