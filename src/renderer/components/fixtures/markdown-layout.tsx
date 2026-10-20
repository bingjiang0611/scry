// Real Chromium layout/interaction fixture, run in an isolated Electron window by the colocated test.
import { createRoot } from 'react-dom/client'
import MarkdownImpl, { WorkspaceFileLinkProvider } from '../MarkdownImpl'
import type { WorkspaceFileTarget } from '../../workspace-links'
import '../../styles.css'

const opened: WorkspaceFileTarget[] = []
const taskLabel = '[[generated/后端转全栈 — 前端学习路线|AI-Native 全栈转型 — 前端新人指南与研发流程摘要]] — 2026-05-25 入库'
const workspaces = ['/Users/example/myNote', '/Users/example/a/much/longer/project/path']
const browserUrl = 'http://localhost:8791/index.html'
const source = `- [ ] ${taskLabel}\n\n- [ ] 第二条待读任务用于保持与真实清单相同的 loose list 结构\n\n\`待读清单.md\`\n\n\`~/Papers/reading/report.md\`\n\n\`${browserUrl}\``

const assert = (ok: unknown, message: string): void => { if (!ok) throw new Error(message) }
const wait = (check: () => boolean, label: string): Promise<void> => {
  if (check()) return Promise.resolve()
  const deadline = performance.now() + 4_000
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const observer = new MutationObserver(() => inspect())
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      observer.disconnect()
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const inspect = (): void => {
      try {
        if (check()) finish()
      } catch (error) {
        finish(error as Error)
      }
    }
    const timer = setTimeout(() => finish(new Error(`UI condition timed out: ${label}`)), Math.max(0, deadline - performance.now()))
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    inspect()
  })
}

async function run(): Promise<void> {
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <div className="right-panel-slot" style={{ width: 420, height: 700 }}>
      <section className="workspace-panel">
        <div className="workspace-editor markdown">
          <div className="workspace-editorbody">
            <div className="workspace-source" />
            <div className="workspace-preview">
              <article className="md workspace-preview-content">
                <WorkspaceFileLinkProvider workspaces={workspaces} onOpen={(target) => opened.push(target)}>
                  <MarkdownImpl>{source}</MarkdownImpl>
                </WorkspaceFileLinkProvider>
              </article>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
  await wait(() => document.querySelectorAll('.md-file-ref').length === 2, 'markdown content')

  const item = document.querySelector<HTMLElement>('.task-list-item')!
  const checkbox = item.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
  let taskText: Node | null = null
  while (!taskText) {
    const node = walker.nextNode()
    if (!node) break
    if (node.textContent?.includes('generated/')) taskText = node
  }
  assert(taskText, 'task label text must render')
  const range = document.createRange()
  range.selectNodeContents(taskText!)
  const textBox = range.getBoundingClientRect()
  const itemBox = item.getBoundingClientRect()
  assert(checkbox.getBoundingClientRect().width > 0, 'task checkbox must remain visible')
  assert(textBox.width >= itemBox.width * 0.7, `task text must use the row width: ${textBox.width}/${itemBox.width}`)
  assert(textBox.height < 120, `task text must wrap horizontally instead of one character per line: ${textBox.height}`)

  const links = [...document.querySelectorAll<HTMLButtonElement>('.md-file-ref')]
  links.forEach((link) => link.click())
  assert(JSON.stringify(opened) === JSON.stringify([
    { cwd: '/Users/example/myNote', path: '待读清单.md' },
    { cwd: '~', path: 'Papers/reading/report.md' }
  ]), `file links must retain their authorization roots: ${JSON.stringify(opened)}`)

  const browserLink = document.querySelector<HTMLAnchorElement>(`a[href="${browserUrl}"]`)
  assert(browserLink?.target === '_blank', 'HTTP code span must be an external browser link')

  // Exercise selection with Chromium input, not Range.addRange(), which bypasses user-select.
  root.render(
    <article className="md" style={{ width: 760 }}>
      <WorkspaceFileLinkProvider workspaces={workspaces} onOpen={() => {
        document.body.dataset.opened = String(Number(document.body.dataset.opened ?? 0) + 1)
      }}>
        <MarkdownImpl>{'| 字段 | 内容 |\n| --- | --- |\n| Resource name | `rate-aigc-image-udtf.jar` |\n| Resource file | `/Users/example/myNote/resources/rate-aigc-image-udtf.jar` |\n| Comment | 保持 `IFD` |'}</MarkdownImpl>
      </WorkspaceFileLinkProvider>
    </article>
  )
  await wait(() => document.querySelectorAll('td .md-file-ref').length === 2, 'table file links')
  document.addEventListener('copy', (event) => {
    // Observe the native copy command without overwriting the developer's clipboard.
    document.body.dataset.copied = window.getSelection()?.toString() ?? ''
    event.preventDefault()
  })
  console.log('SCRY_MARKDOWN_SELECTION_READY')
  await wait(() => document.body.dataset.selectionTest === 'done', 'native selection checks')
  console.log('SCRY_MARKDOWN_LAYOUT_TEST_READY')
  browserLink?.click()
}

void run().catch((error) => console.error('SCRY_MARKDOWN_LAYOUT_TEST_FAILED', String(error)))
