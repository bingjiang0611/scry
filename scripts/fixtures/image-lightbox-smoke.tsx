import { createRoot } from 'react-dom/client'
import type { Turn } from '../../src/renderer/format'
import { ComposerProjectFixture } from './composer-project-smoke'
import { WorkspacePreviewFixture } from './workspace-preview-smoke'
import { AssistantTurn, UserMessage } from '../../src/renderer/components/ChatTurn'
import MarkdownImpl from '../../src/renderer/components/MarkdownImpl'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/codex-alignment.css'

// Synthetic images only; no Provider, preload, persisted session or private screenshot.
const image = (width: number, height: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#111'
  context.font = '40px sans-serif'
  context.fillText('Image preview regression', 24, 60)
  return { kind: 'image' as const, name: `${width}x${height}.png`, mimeType: 'image/png' as const, dataBase64: canvas.toDataURL().split(',')[1] }
}

const longReferenceMarkdown = `## Large reference document\n\n${'Paragraph with [docs] reference. '.repeat(2_000)}\n\n[docs]: https://example.com`
const goalPausedTurn = {
  runId: 'pi-goal-paused', userText: '/goal resume', done: true,
  items: [{
    id: 'pi-result', runId: 'pi-goal-paused', ts: '2026-09-20T15:49:38Z',
    kind: 'harness' as const, stage: 'result', providerId: 'pi' as const,
    isError: false, providerStopReason: 'toolUse',
    toolTermination: {
      tool: 'goal_complete',
      message: 'Previous completion review is unresolved. It will not be replayed, including after resume. Completion remains unverified.'
    }
  }]
}

const piFeedbackTurn: Turn = {
  runId: 'pi-feedback', userText: '继续', done: true,
  items: ([
    { id: 'reply', kind: 'model', stage: 'text', text: '已完成代码检查。' },
    {
      id: 'tps', kind: 'harness', stage: 'runtime:extension_ui', text: 'TPS 25.7 tok/s.',
      runtimeMetadata: { method: 'notify', notifyType: 'info' }
    },
    {
      id: 'warning', kind: 'harness', stage: 'runtime:extension_ui', text: '扩展警告内容',
      runtimeMetadata: { method: 'notify', notifyType: 'warning' }
    },
    {
      id: 'command', kind: 'harness', stage: 'result', text: '/test-command 已执行',
      providerCommand: { name: 'test-command', source: 'extension', modelTurn: 'unobserved' }
    }
  ] satisfies Partial<Turn['items'][number]>[]).map((event) => ({
    ...event, runId: 'pi-feedback', ts: '2026-09-20T15:49:38Z', providerId: 'pi', runtimeProvider: 'pi_rpc'
  }))
}

const toolTurn = {
  runId: 'tool-lazy-smoke',
  userText: 'inspect tools',
  done: true,
  items: Array.from({ length: 100 }, (_, index) => ({
    id: `tool-${index}`,
    runId: 'tool-lazy-smoke',
    ts: new Date(index).toISOString(),
    kind: 'tool' as const,
    stage: 'tool:Read',
    tool: 'Read',
    toolUseId: `use-${index}`,
    filePath: `/tmp/file-${index}.txt`
  }))
}

createRoot(document.getElementById('root')!).render(
  <>
    <main style={{ width: '65vw', height: '60vh', overflow: 'auto', margin: '100px 0 0 20px' }}>
      <div className="transcript-turn">
        <UserMessage text="点击图片查看完整内容" attachments={[image(1600, 2400), image(2400, 900)]} />
      </div>
    </main>
    <section id="goal-paused-fixture" hidden style={{ position: 'fixed', left: 20, top: 20, width: '65vw', zIndex: 30 }}>
      <AssistantTurn turn={goalPausedTurn} selectedId={null} onSelect={() => {}} />
    </section>
    <section id="pi-feedback-fixture" style={{ position: 'absolute', left: '-10000px', width: 800 }}>
      {[false, true].map((done) => (
        <AssistantTurn key={String(done)} turn={{ ...piFeedbackTurn, done }} selectedId={null} onSelect={() => {}} />
      ))}
    </section>
    <section id="performance-fixture" className="md" style={{ position: 'absolute', left: '-10000px', width: 800 }}>
      <MarkdownImpl>{longReferenceMarkdown}</MarkdownImpl>
      <AssistantTurn turn={toolTurn} selectedId={null} onSelect={() => {}} />
    </section>
    <ComposerProjectFixture />
    <WorkspacePreviewFixture />
    <aside id="summary" style={{ position: 'fixed', right: 0, top: 0, width: '25vw', height: '100vh', zIndex: 20 }}>Environment</aside>
  </>
)
