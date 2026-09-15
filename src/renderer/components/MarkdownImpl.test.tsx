import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownImpl, {
  normalizeMarkdownForDisplay,
  streamingMarkdownInterval,
  WorkspaceFileLinkProvider
} from './MarkdownImpl'

describe('streaming Markdown cadence', () => {
  it('keeps short answers responsive and progressively protects long-turn rendering', () => {
    expect(streamingMarkdownInterval(1_000)).toBe(48)
    expect(streamingMarkdownInterval(12_000)).toBe(48)
    expect(streamingMarkdownInterval(12_001)).toBe(80)
    expect(streamingMarkdownInterval(48_001)).toBe(120)
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
