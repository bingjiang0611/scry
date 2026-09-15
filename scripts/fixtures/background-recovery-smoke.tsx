import type { ActiveRun, TraceEvent } from '../../src/shared/trace'
import { latestBackgroundWork, type BackgroundWork } from '../../src/shared/background-work'
import type { TraceBacklogState } from '../../src/renderer/env'
import { useAgentSession } from '../../src/renderer/hooks/useAgentSession'
import { useBackgroundWork } from '../../src/renderer/hooks/useBackgroundWork'

const work: BackgroundWork = {
  providerId: 'qoder', phase: 'waiting', quiet: false, coverage: 'partial', taskStop: 'unavailable',
  lastEventAt: 1, revision: 1, tasks: [{ taskId: 'task', toolUseId: 'call', tool: 'Bash', description: 'fixture only', observedAt: 1 }]
}
const snapshot = (phase: BackgroundWork['phase'], runId = 'recovery'): ActiveRun => ({
  runId, userText: 'fixture', done: false, items: [{
    id: phase, runId, ts: '', kind: 'harness', stage: 'runtime:background_work', backgroundWork: { ...work, phase, revision: phase === 'waiting' ? 1 : 2 }
  }]
})
const listeners = new Map<string, Set<(event: unknown) => void>>()
function listen<T>(name: string, callback: (event: T) => void) {
  const wrapped = (event: unknown) => callback(event as T)
  const set = listeners.get(name) ?? new Set()
  listeners.set(name, set)
  set.add(wrapped)
  return () => { set.delete(wrapped) }
}
const emit = (name: string, event: unknown) => { for (const callback of listeners.get(name) ?? []) callback(event) }
let server = snapshot('waiting')
const pending: Array<() => void> = []
let hydrateSidebar = () => {}
let acknowledgments = 0

export function installRecoveryBridge(): void {
  Object.defineProperty(window, 'scry', { configurable: true, value: {
    activeRun: async () => snapshot('waiting'),
    activeRuns: () => new Promise<ActiveRun[]>((resolve) => { hydrateSidebar = () => resolve([snapshot('waiting')]) }),
    focusedRunSnapshot: () => {
      const captured = server
      return new Promise<ActiveRun>((resolve) => { pending.push(() => resolve(captured)) })
    },
    traceResynchronized: async () => {
      document.getElementById('recovery')!.dataset.acks = String(++acknowledgments)
    },
    onTrace: (callback: (events: TraceEvent[]) => void) => listen('trace', callback),
    onTraceHealth: (callback: (event: TraceBacklogState) => void) => listen('health', callback),
    onBackgroundWork: (callback: (event: { runId: string; work: BackgroundWork }) => void) => listen('background', callback),
    onTurnDone: (callback: (event: { runId: string; providerTurnId?: string }) => void) => listen('done', callback),
    onError: (callback: (event: { runId: string; message: string }) => void) => listen('error', callback)
  } })
}

export function BackgroundRecoveryFixture() {
  const session = useAgentSession()
  const background = useBackgroundWork()
  const turn = session.turns.at(-1)
  return <div id="recovery" data-run={turn?.runId} data-done={String(turn?.done)} data-error={turn?.error ?? ''}
    data-phase={latestBackgroundWork(turn?.items ?? [])?.phase} data-restoring={String(session.restoring)} data-busy={String(session.busy)}
    data-items={(turn?.items ?? []).map((event) => event.id).join(',')}
    data-sidebar-phase={background.recovery?.phase ?? 'none'}>
    <button id="trace-batch" onClick={() => emit('trace', [
      { id: 'batch-a', runId: 'recovery', ts: '', kind: 'model', stage: 'text', text: 'a' },
      { id: 'batch-b', runId: 'recovery', ts: '', kind: 'tool', stage: 'tool_use', tool: 'Read' }
    ] satisfies TraceEvent[])}>trace batch</button>
    <button id="begin-recovery" onClick={() => emit('health', {
      degraded: true, skippedEvents: 1, bufferedEvents: 0, bufferedBytes: 0, inFlightBytes: 0, resyncRequired: true
    })}>recover</button>
    <button id="finish-done" onClick={() => emit('done', { runId: 'recovery', providerTurnId: 'native-terminal' })}>done</button>
    <button id="finish-error" onClick={() => emit('error', { runId: 'recovery', message: 'transport lost' })}>error</button>
    <button id="server-new" onClick={() => { server = snapshot('working') }}>new snapshot</button>
    <button id="resolve-first" onClick={() => pending.shift()?.()}>resolve first</button>
    <button id="resolve-last" onClick={() => pending.pop()?.()}>resolve last</button>
    <button id="switch-focus" onClick={() => session.replaceWithParsedSession('other-session', [], { activeRun: snapshot('working', 'other') })}>switch</button>
    <button id="sidebar-hydrate" onClick={() => hydrateSidebar()}>hydrate</button>
    <button id="sidebar-event" onClick={() => emit('background', { runId: 'recovery', work: { ...work, phase: 'working', revision: 2 } })}>live sidebar</button>
    <button id="sidebar-old" onClick={() => emit('background', { runId: 'recovery', work })}>stale sidebar</button>
    <button id="sidebar-inactive" onClick={() => emit('background', { runId: 'recovery', work: { ...work, phase: 'inactive', revision: 3 } })}>inactive sidebar</button>
  </div>
}
