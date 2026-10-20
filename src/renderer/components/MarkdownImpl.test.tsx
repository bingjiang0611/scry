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

describe('MarkdownImpl code block text', () => {
  it('omits the parser-added final newline without trimming source whitespace', () => {
    for (const [source, expected] of [
      ['```\n/Users/example/Downloads/rate-aigc-image-udtf.jar\n```', '/Users/example/Downloads/rate-aigc-image-udtf.jar'],
      ['```sh\n  first  \nsecond\n```', '  first  \nsecond'],
      ['```\nfirst\n\n```', 'first\n'],
      ['    indented code\n', 'indented code']
    ]) {
      const html = renderToStaticMarkup(<MarkdownImpl>{source}</MarkdownImpl>)
      expect(html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1]).toBe(expected)
    }
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

  it('resolves filenames against the directory written in the same paragraph, without leaking into the next paragraph', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'截图留在 `/var/tmp/screens/`（`remote-workspace.png`、[settings](remote-settings.png)、`asset.custom`）。\n\n`next.md`'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )
    for (const name of ['remote-workspace.png', 'remote-settings.png', 'asset.custom']) {
      expect(html).toContain(`/var/tmp/screens/${name} ·`)
    }
    expect(html).toContain('next.md · 在右侧文件面板打开')
    expect(html).not.toContain('/var/tmp/screens/next.md')
  })

  it('decodes Markdown file URLs once while preserving literal code paths and file URLs', () => {
    const report = 'generated/2026-10-18 AI 学习资源推荐清单回检.md'
    const encodedReport = report.split('/').map(encodeURIComponent).join('/')
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{`[查看完整报告](${encodedReport}) [中文](generated/中文.md) [percent](docs/literal%2520.md) \`docs/literal%20.md\` [file](file:///repo/docs/literal%2520%23L12.md)`}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )
    expect(html).toContain(`${report} · 打开文件`)
    expect(html).toContain('generated/中文.md · 打开文件')
    expect(html).toContain('docs/literal%20.md · 打开文件')
    expect(html).toContain('docs/literal%20.md · 在右侧文件面板打开')
    expect(html).toContain('docs/literal%20#L12.md · 打开文件')
    expect(html.match(/class="md-file-ref"/g)).toHaveLength(5)
  })

  it('decodes filenames before joining a Markdown link to its paragraph directory', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'`generated/中文%20/` [报告](AI%20%E6%8A%A5%E5%91%8A.md) [目录](docs/%E4%B8%AD%E6%96%87/) [笔记](%E7%AC%94%E8%AE%B0.md)\n\n[独立](%E7%AC%94%E8%AE%B0.md)'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )
    expect(html).toContain('generated/中文%20/AI 报告.md · 打开文件')
    expect(html).toContain('docs/中文/笔记.md · 打开文件')
    expect(html).toContain('笔记.md · 打开文件')
    expect(html).not.toContain('docs/中文/独立')
  })

  it('decodes file links in headings and tables and rejects invalid encoded targets', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'## [标题](docs/%E4%B8%AD%E6%96%87.md)\n\n| 报告 |\n| --- |\n| [表格](docs/AI%20report.md) |\n\n[invalid](docs/%E4.md) [null](docs/%00.md) [scheme](javascript%3Aalert%281%29) [fragment](#section)'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )
    expect(html).toContain('docs/中文.md · 打开文件')
    expect(html).toContain('docs/AI report.md · 打开文件')
    expect(html.match(/class="md-file-ref"/g)).toHaveLength(2)
    expect(html).toContain('<span>invalid</span>')
    expect(html).toContain('<span>null</span>')
    expect(html).toContain('<span>scheme</span>')
  })

  it('keeps multiple directory groups, absolute files, URLs and fenced code separate', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} onOpen={() => {}}>
        <MarkdownImpl>{'`~/screens/` `first.png` `/var/tmp/other/` `second.png` `/repo/docs/explicit.md` `https://example.com/x.png`\n\n```text\n/var/tmp/screens/\nnot-a-link.png\n```'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )
    expect(html).toContain('screens/first.png · 在外部应用打开')
    expect(html).toContain('/var/tmp/other/second.png · 在外部应用打开')
    expect(html).toContain('docs/explicit.md · 在右侧文件面板打开')
    expect(html).toContain('href="https://example.com/x.png"')
    expect(html).not.toContain('not-a-link.png ·')
  })

  it('resolves an abbreviated filename using only the enclosing turn evidence and its original cwd', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/different-project']} onOpen={() => {}}>
        <WorkspaceFileLinkProvider workspaces={['/repo']} filePaths={[
          '/repo/designs/scry-unified-remote/brief.md', '/repo/docs/desktop-remote.md'
        ]}>
          <MarkdownImpl>{'包含原型、`brief.md`，以及写进 `docs/desktop-remote.md` 的这次反馈记录。'}</MarkdownImpl>
        </WorkspaceFileLinkProvider>
        <MarkdownImpl>{'另一轮的 `brief.md`'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )
    expect(html).toContain('designs/scry-unified-remote/brief.md · 在右侧文件面板打开')
    expect(html).toContain('docs/desktop-remote.md · 在右侧文件面板打开')
    expect(html).toContain('brief.md · 在右侧文件面板打开')
  })

  it('offers the full paths when turn evidence contains ambiguous filenames instead of guessing', () => {
    const html = renderToStaticMarkup(
      <WorkspaceFileLinkProvider workspaces={['/repo']} filePaths={['designs/a/brief.md', 'designs/b/brief.md']} onOpen={() => {}}>
        <MarkdownImpl>{'`brief.md` [brief](brief.md) `./brief.md`'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    )
    expect(html.match(/<select/g)).toHaveLength(2)
    expect(html).toContain('designs/a/brief.md')
    expect(html).toContain('designs/b/brief.md')
    expect(html.match(/class="md-file-ref"/g)).toHaveLength(3)
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
