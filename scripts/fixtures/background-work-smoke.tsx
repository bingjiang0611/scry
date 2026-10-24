import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { BackgroundWork } from '../../src/shared/background-work'
import { ChatView } from '../../src/renderer/components/ChatView'
import { BackgroundRecoveryFixture, installRecoveryBridge } from './background-recovery-smoke'
import '../../src/renderer/styles.css'
import '../../src/renderer/motion.css'
import '../../src/renderer/codex-alignment.css'

const noop = () => {}
// Only the clock scenario replaces wall time/timers; React and browser frames stay real.
const clockScenario = new URLSearchParams(location.search).get('mode') === 'clock'
const clock = { now: Date.parse('2026-10-08T12:00:00Z'), turnReads: 0 }
if (clockScenario) {
  let nextId = 0
  let visibility: DocumentVisibilityState = 'visible'
  const timers = new Map<number, () => void>()
  Date.now = () => clock.now
  window.setInterval = (handler: TimerHandler) => {
    if (typeof handler !== 'function') throw new Error('Expected a timer callback')
    const id = ++nextId
    timers.set(id, () => handler())
    return id
  }
  window.clearInterval = (id) => { if (id != null) timers.delete(id) }
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Object.assign(window, { chatClock: {
    get turnReads() { return clock.turnReads },
    get timers() { return timers.size },
    advance(ms: number) {
      clock.now += ms
      for (const callback of [...timers.values()]) callback()
    },
    visibility(value: DocumentVisibilityState) {
      visibility = value
      document.dispatchEvent(new Event('visibilitychange'))
    }
  } })
}
const initial: BackgroundWork = {
  providerId: 'qoder', phase: 'waiting', quiet: false, coverage: 'partial', taskStop: 'available', lastEventAt: Date.now(),
  tasks: ['a', 'b'].map((id) => ({ taskId: id, toolUseId: `call-${id}`, tool: 'Bash', description: `obsidian append · synthetic-${id} · ${'很长的任务描述/'.repeat(8)}`, observedAt: Date.now() - 60_000 }))
}
function Fixture() {
  const [work, setWork] = useState(initial)
  const [done, setDone] = useState(false)
  const [run, setRun] = useState('fixture-run')
  const [startedAt, setStartedAt] = useState(() => new Date(Date.now()).toISOString())
  const [stops, setStops] = useState(0)
  const [wholeStops, setWholeStops] = useState(0)
  const [stopMode, setStopMode] = useState<'requested' | 'rejected' | 'throw'>('requested')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    Object.defineProperty(window, 'scry', { configurable: true, value: {
      stopBackgroundTask: async ({ runId, taskId }: { runId: string; taskId: string }) => {
        if (runId !== run) throw new Error('Wrong run identity')
        setStops((count) => count + 1)
        if (stopMode === 'throw') throw new Error('Synthetic transport failure')
        if (stopMode === 'rejected') return { status: 'rejected', message: 'Synthetic stop rejection' }
        setWork((work) => ({ ...work, tasks: work.tasks.map((task) => task.taskId === taskId ? { ...task, stopState: 'requested' } : task) }))
        return { status: 'requested', message: '已请求停止；等待 Qoder 返回任务终态。' }
      }
    } })
  }, [run, stopMode])
  return <div id="fixture" data-stops={stops} data-whole-stops={wholeStops}>
    <nav>
      <button id="quiet" onClick={() => setWork((work) => ({ ...work, quiet: true }))}>quiet</button>
      <button id="terminal-a" onClick={() => setWork((work) => ({ ...work, tasks: work.tasks.filter((task) => task.taskId !== 'a') }))}>terminal a</button>
      <button id="resume" onClick={() => setWork((work) => ({ ...work, phase: 'working', quiet: false }))}>resume</button>
      <button id="done" onClick={() => setDone(true)}>done</button>
      <button id="new-run" onClick={() => { setDone(false); setRun((current) => `${current}-next`); setStopMode('requested'); setStartedAt(new Date(Date.now()).toISOString()); setWork(initial) }}>new run</button>
      {clockScenario && <button id="unknown-start" onClick={() => setStartedAt('unknown')}>unknown start</button>}
      <button id="stop-rejected" onClick={() => setStopMode('rejected')}>reject stop</button>
      <button id="stop-throws" onClick={() => setStopMode('throw')}>throw stop</button>
      <button id="unsupported" onClick={() => setWork((work) => ({ ...work, taskStop: 'unavailable' }))}>unsupported</button>
      <button id="pi-wait" onClick={() => { setDone(false); setWork({ ...initial, providerId: 'pi', taskStop: 'unavailable',
        tasks: [{ taskId: 'child', toolUseId: 'child', tool: 'Agent', description: 'worker', observedAt: Date.now() }] }) }}>Pi wait</button>
    </nav>
    <ChatView
      turns={[{ runId: run, get userText() { clock.turnReads++; return '迁移笔记（隔离测试）' }, done, items: [
        { id: 'reply', runId: run, ts: startedAt, kind: 'model', stage: 'text', text: '迁入完成，等待后台日志任务。' },
        ...(!clockScenario ? [{ id: 'background', runId: run, ts: startedAt, kind: 'harness' as const, stage: 'runtime:background_work', backgroundWork: work }] : [])
      ] }]}
      selectedId={null} scrollRef={scrollRef} textareaRef={textareaRef}
      cwd="/synthetic/vault" recent={[]} agents={[]} selectedAgentId={work.providerId}
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
const recovery = new URLSearchParams(location.search).get('mode') === 'recovery'
if (recovery) installRecoveryBridge()
createRoot(document.getElementById('root')!).render(recovery ? <BackgroundRecoveryFixture /> : <Fixture />)
