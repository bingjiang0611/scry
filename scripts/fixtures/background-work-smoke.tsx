import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { BackgroundWork } from '../../src/shared/background-work'
import { ChatView } from '../../src/renderer/components/ChatView'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

const noop = () => {}
const initial: BackgroundWork = {
  providerId: 'qoder', phase: 'waiting', quiet: false, coverage: 'partial', taskStop: 'available', lastEventAt: Date.now(),
  tasks: ['a', 'b'].map((id) => ({ taskId: id, toolUseId: `call-${id}`, tool: 'Bash', description: `obsidian append · synthetic-${id} · ${'很长的任务描述/'.repeat(8)}`, observedAt: Date.now() - 60_000 }))
}
function Fixture() {
  const [work, setWork] = useState(initial)
  const [done, setDone] = useState(false)
  const [run, setRun] = useState('fixture-run')
  const [stops, setStops] = useState(0)
  const [wholeStops, setWholeStops] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    Object.defineProperty(window, 'scry', { configurable: true, value: {
      stopBackgroundTask: async ({ runId, taskId }: { runId: string; taskId: string }) => {
        if (runId !== run) throw new Error('Wrong run identity')
        setStops((count) => count + 1)
        setWork((work) => ({ ...work, tasks: work.tasks.map((task) => task.taskId === taskId ? { ...task, stopState: 'requested' } : task) }))
        return { status: 'requested', message: '已请求停止；等待 Qoder 返回任务终态。' }
      }
    } })
  }, [run])
  return <div id="fixture" data-stops={stops} data-whole-stops={wholeStops}>
    <nav>
      <button id="quiet" onClick={() => setWork((work) => ({ ...work, quiet: true }))}>quiet</button>
      <button id="terminal-a" onClick={() => setWork((work) => ({ ...work, tasks: work.tasks.filter((task) => task.taskId !== 'a') }))}>terminal a</button>
      <button id="resume" onClick={() => setWork((work) => ({ ...work, phase: 'working', quiet: false }))}>resume</button>
      <button id="done" onClick={() => setDone(true)}>done</button>
      <button id="new-run" onClick={() => { setDone(false); setRun('fixture-next'); setWork(initial) }}>new run</button>
      <button id="unsupported" onClick={() => setWork((work) => ({ ...work, taskStop: 'unavailable' }))}>unsupported</button>
    </nav>
    <ChatView
      turns={[{ runId: run, userText: '迁移笔记（隔离测试）', done, items: [
        { id: 'reply', runId: run, ts: new Date().toISOString(), kind: 'model', stage: 'text', text: '迁入完成，等待后台日志任务。' },
        { id: 'background', runId: run, ts: new Date().toISOString(), kind: 'harness', stage: 'runtime:background_work', backgroundWork: work }
      ] }]}
      selectedId={null} scrollRef={scrollRef} textareaRef={textareaRef}
      cwd="/synthetic/vault" recent={[]} agents={[]} selectedAgentId="qoder"
      runControls={{ permissionMode: 'default' }} runControlCatalog={{ models: [], permissions: [] }}
      input="核验后继续" busy={!done} draftAttachments={[]} queuedPrompts={[]}
      slashOpen={false} slashLoading={false} slashCmds={[]} slashSel={0}
      onSelect={noop} onInput={noop} onChooseFolder={noop} onPickRecent={noop} onRemoveRecent={noop}
      onRetrySlash={noop} onPickSlash={noop} onSlashSel={noop} onHideSlash={noop}
      onSend={noop} onStop={() => setWholeStops((count) => count + 1)} onPasteImages={noop} onPasteClipboardImage={noop}
      onRemoveDraftAttachment={noop} onRemoveQueuedPrompt={noop} onSelectAgent={noop}
      onRunModel={noop} onRunEffort={noop} onPermissionMode={noop} onRescan={noop}
    />
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
