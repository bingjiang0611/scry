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
const wait = async (check: () => boolean, label: string): Promise<void> => {
  const deadline = performance.now() + 4_000
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`UI condition timed out: ${label}`)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

async function run(): Promise<void> {
  createRoot(document.getElementById('root')!).render(
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
  console.log('SCRY_MARKDOWN_LAYOUT_TEST_READY')
  browserLink?.click()
}

void run().catch((error) => console.error('SCRY_MARKDOWN_LAYOUT_TEST_FAILED', String(error)))
