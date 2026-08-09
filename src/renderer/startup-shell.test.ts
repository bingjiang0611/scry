import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer 启动画布', () => {
  const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')

  it('不在 React 接管前渲染旧品牌启动页', () => {
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('<meta name="color-scheme" content="dark light" />')
    expect(html).not.toContain('boot-shell')
    expect(html).not.toContain('boot-logo')
  })

  it('启动根节点跟随主题画布，不把透明的主区固定成深色', () => {
    expect(html).toContain('background: var(--bg, #07090d);')
    expect(html).not.toContain('background: #0b0d12;')
  })
})
