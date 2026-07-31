import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownImpl from './MarkdownImpl'

describe('MarkdownImpl trust boundary', () => {
  it('does not emit remote image requests or dangerous links', () => {
    const html = renderToStaticMarkup(
      <MarkdownImpl>{'![tracker](https://attacker.invalid/pixel.png) [local](file:///etc/passwd)'}</MarkdownImpl>
    )
    expect(html).toContain('远程图片已阻止')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('https://attacker.invalid')
    expect(html).not.toContain('file:///etc/passwd')
  })

  it('opens HTTP links externally and keeps inline image data renderable', () => {
    const html = renderToStaticMarkup(
      <MarkdownImpl>{'[docs](https://example.com) ![inline](data:image/png;base64,AA==)'}</MarkdownImpl>
    )
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('<img')
  })
})
