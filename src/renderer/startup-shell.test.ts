import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer 启动画布', () => {
  const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')

  it('不在 React 接管前渲染旧品牌启动页', () => {
    expect(html).toContain('<div id="root"></div>')
    expect(html).not.toContain('boot-shell')
    expect(html).not.toContain('boot-logo')
  })
})
