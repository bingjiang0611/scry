import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import MarkdownImpl, {
  normalizeMarkdownForDisplay,
  shouldUseLightweightStreamingMarkdown,
  splitMarkdownForProgressiveRender,
  streamingMarkdownInterval,
  WorkspaceFileLinkProvider
} from './MarkdownImpl'

describe('streaming Markdown cadence', () => {
  it('keeps short answers responsive and progressively protects long-turn rendering', () => {
    expect(streamingMarkdownInterval(1_000)).toBe(80)
    expect(streamingMarkdownInterval(12_000)).toBe(80)
    expect(streamingMarkdownInterval(12_001)).toBe(120)
    expect(streamingMarkdownInterval(48_001)).toBe(200)
  })

  it('splits large completed documents only at safe top-level heading boundaries', () => {
    const source = Array.from({ length: 20 }, (_, index) => `## Section ${index}\n\n${'body '.repeat(600)}`).join('\n')
    const chunks = splitMarkdownForProgressiveRender(source)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n')).toBe(source)
    expect(chunks.every((chunk) => chunk.startsWith('## Section'))).toBe(true)

    const prose = Array.from({ length: 30 }, (_, index) => `Paragraph ${index} ${'body '.repeat(400)}`).join('\n\n')
    expect(splitMarkdownForProgressiveRender(prose)).toEqual([prose])

    const referenceSource = `${source}\n\n[docs]:https://example.com`
    expect(splitMarkdownForProgressiveRender(referenceSource)).toEqual([referenceSource])

    for (const opening of ['<div>', '<div\nclass="note">', '<?xml version="1.0"?>', '<!DOCTYPE html>', '<![CDATA[']) {
      const htmlBlockSource = `${opening}\n# not a Markdown heading\n</div>\n\n${source}`
      expect(splitMarkdownForProgressiveRender(htmlBlockSource)).toEqual([htmlBlockSource])
    }
  })

  it('preserves GFM output across real headings and does not close fences with trailing text', () => {
    const body = 'body '.repeat(2_000)
    const source = `# First\n\n${body}\n\n- first\n\n- second\n\n# Second\n\n\`\`\`js\n${body}\n\`\`\`not-a-close\n# still code\n\`\`\`\n\n# Third\n\n${body}\n\n# Fourth\n\n${body}\n\n# Fifth\n\n${body}`
    const render = (text: string): string => renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>)
    const chunks = splitMarkdownForProgressiveRender(source)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map(render).join('\n')).toBe(render(source))
    expect(chunks.some((chunk) => chunk.startsWith('# still code'))).toBe(false)
  })

  it('keeps unsafe whole-document parses selectable until the user explicitly formats them', () => {
    expect(shouldUseLightweightStreamingMarkdown(48_000, true)).toBe(false)
    expect(shouldUseLightweightStreamingMarkdown(48_001, true)).toBe(true)
    expect(shouldUseLightweightStreamingMarkdown(100_000, false)).toBe(false)

    const source = `# heading\n\n${'body '.repeat(10_000)}`
    const streaming = renderToStaticMarkup(<MarkdownImpl streaming>{source}</MarkdownImpl>)
    const completed = renderToStaticMarkup(<MarkdownImpl>{source}</MarkdownImpl>)
    expect(streaming).toContain('class="md-streaming-plain"')
    expect(streaming).toContain('# heading')
    expect(completed).toContain('格式化全文')
    expect(completed).toContain('aria-label="大型回复完整文本"')
    expect(completed).not.toContain('<h1>heading</h1>')

    const safelyChunked = Array.from({ length: 20 }, (_, index) => `## Section ${index}\n\n${'body '.repeat(600)}`).join('\n')
    expect(renderToStaticMarkup(<MarkdownImpl>{safelyChunked}</MarkdownImpl>)).toContain('<h2>Section 0</h2>')
  })
})

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
    // 内联图片仍然放行，但按需解码，避免长会话一次性解码所有历史图片。
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
  })

  it('repairs common model-authored strong spacing without touching code', () => {
    const source = '**我的判断： **最值得关注。\n\n**结论：**继续优化。\n\n先**检查**项目。\n\n`** inline literal **`\n\n```md\n** fenced literal **\n```'
    expect(normalizeMarkdownForDisplay(source)).toBe(
      '**我的判断：** 最值得关注。\n\n**结论：** 继续优化。\n\n先**检查**项目。\n\n`** inline literal **`\n\n```md\n** fenced literal **\n```'
    )

    const html = renderToStaticMarkup(<MarkdownImpl>{source}</MarkdownImpl>)
    expect(html).toContain('<strong>我的判断：</strong> 最值得关注。')
    expect(html).toContain('<strong>结论：</strong> 继续优化。')
    expect(html).toContain('<code>** inline literal **</code>')
    expect(html).toContain('** fenced literal **')
  })

  it('turns workspace file code spans into explicit internal or browser actions', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'`/repo/src/App.tsx` `/repo/docs/report.pdf` `Promise<void>`\n\n```text\n/repo/src/fenced.ts\n```'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )

    expect(html).toContain('class="md-file-ref"')
    expect(html.match(/md-file-ref-icon/g)).toHaveLength(2)
    expect(html).not.toContain('md-file-ref-label')
    expect(html).toContain('src/App.tsx · 在右侧文件面板打开')
    expect(html).toContain('docs/report.pdf · 在外部应用打开')
    expect(html.match(/class="md-file-ref"/g)).toHaveLength(2)
    expect(html).toContain('<code>Promise&lt;void&gt;</code>')
    expect(html).toContain('/repo/src/fenced.ts')
  })

  it('opens an HTTP URL code span in the browser instead of treating its extension as a workspace file', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'`http://localhost:8791/index.html`'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )

    expect(html).toContain('<a href="http://localhost:8791/index.html" target="_blank" rel="noopener noreferrer">')
    expect(html).toContain('<code>http://localhost:8791/index.html</code>')
    expect(html).not.toContain('md-file-ref')
  })

  it('keeps shell home file paths clickable through the authorized home root', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'`~/Papers/reading/report.md`'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )

    expect(html).toContain('class="md-file-ref"')
    expect(html).toContain('Papers/reading/report.md · 在右侧文件面板打开')
    expect(html).toContain('<code>~/Papers/reading/report.md</code>')
  })

  it('opens explicit file links of any extension while rejecting executable URL schemes', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'[binary](assets/custom.format) [license](LICENSE) [parent](../report.docx) [absolute](file:///Users/example/Notes/report.md) [unsafe](javascript:alert) [anchor](#section)'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )
    expect(html.match(/class="md-file-ref"/g)).toHaveLength(4)
    expect(html).toContain('assets/custom.format · 打开文件')
    expect(html).toContain('href="#section"')
    expect(html).not.toContain('href="javascript:')
  })

  it('keeps explicitly linked code as one HTTP link instead of nesting a file button', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'[`/repo/src/App.tsx`](https://example.com)'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )

    expect(html).toContain('<a href="https://example.com"')
    expect(html).toContain('<code>/repo/src/App.tsx</code>')
    expect(html).not.toContain('md-file-ref')
    expect(html).not.toContain('<a href="https://example.com"><button')
  })

  it('keeps long GFM task-list text in the task item beside its checkbox', () => {
    const label = '[[generated/后端转全栈 — 前端学习路线|AI-Native 全栈转型 — 前端新人指南与研发流程摘要]] — 2026-05-25 入库'
    const html = renderToStaticMarkup(<MarkdownImpl>{`- [ ] ${label}`}</MarkdownImpl>)

    expect(html).toContain('class="task-list-item"')
    expect(html).toContain('<input type="checkbox" disabled=""/>')
    expect(html).toContain(label)
  })

  it('wraps GFM tables in a keyboard-scrollable region', () => {
    const html = renderToStaticMarkup(
      <MarkdownImpl>{'| 项目 | 状态 |\n| --- | --- |\n| Scry | ready |'}</MarkdownImpl>
    )
    expect(html).toContain('class="md-table-scroll"')
    expect(html).toContain('aria-label="表格，可横向和纵向滚动"')
    expect(html).toContain('<table>')
  })
})
