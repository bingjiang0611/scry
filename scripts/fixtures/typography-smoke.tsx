import { createRoot } from 'react-dom/client'
import { installOverflowTitles } from '../../src/renderer/overflow-title'
import { ChineseHeadingText } from '../../src/renderer/typography'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/analytics-evidence.css'
import '../../src/renderer/inventory-evidence.css'
import '../../src/renderer/session-evidence.css'
import '../../src/renderer/codex-alignment.css'

const copy = {
  heading: '在本地查看 Agent 执行如何变成可以核对的证据',
  paragraph: 'Scry keeps the execution record readable, so a final line does not end with one isolated word.',
  metric: '运行中请求',
  number: '11111',
  label: '一个很长的本机会话名称，需要在侧边栏中安全截断而不是溢出，并在悬停时保留完整文本',
  action: '打开工作区',
  mixed: 'Scry 通过 Provider CLI 记录 30 tokens，并把本地 Agent 的执行证据整理成可核对的时间线。'
} as const

function Fixture() {
  return (
    <>
      <style>{`
        .typography-smoke-page { min-height: 100vh; display: grid; place-items: center; padding: 48px; background: var(--bg); color: var(--fg); }
        .typography-smoke-card { width: 560px; padding: 28px; border: 1px solid var(--border2); border-radius: var(--r-md); background: var(--panel); }
        .typography-smoke-card h1 { max-width: 16ch; margin: 0 0 18px; font-size: 30px; line-height: 1.24; }
        .typography-smoke-card p { max-width: 44ch; margin: 16px 0; }
        .typography-smoke-metric { margin: 22px 0; }
        .typography-smoke-metric dt { color: var(--dim); }
        .typography-smoke-metric dd { margin: 4px 0 0; font-size: 30px; font-weight: 650; }
        .typography-smoke-row { display: flex; align-items: center; gap: 12px; width: 100%; }
        .typography-smoke-flex-item { flex: 1; }
        .typography-smoke-row button { padding: 7px 11px; }
        .typography-smoke-chat { position: fixed; top: 0; left: -10000px; width: 240px; height: 80px; }
        .typography-smoke-chat-content { width: 600px; height: 200px; }
      `}</style>
      <main className="typography-smoke-page">
      <section className="typography-smoke-card">
        <h1 id="typography-heading" className="zh-balanced-heading" lang="zh-CN"><ChineseHeadingText>{copy.heading}</ChineseHeadingText></h1>
        <p id="typography-paragraph">{copy.paragraph}</p>
        <dl className="typography-smoke-metric">
          <dt>{copy.metric}</dt>
          <dd id="typography-number" data-tabular>{copy.number}</dd>
        </dl>
        <div className="typography-smoke-row">
          <span className="typography-smoke-flex-item" data-truncate-container>
            <span id="typography-truncated" data-truncate>{copy.label}</span>
          </span>
          <button type="button">{copy.action}</button>
        </div>
        <p id="typography-mixed" className="zh-prose" lang="zh-CN">{copy.mixed}</p>
      </section>
      <div id="typography-chat" className="chat typography-smoke-chat" aria-hidden="true">
        <div className="typography-smoke-chat-content" />
      </div>
      </main>
    </>
  )
}

installOverflowTitles(document)
createRoot(document.getElementById('root')!).render(<Fixture />)
