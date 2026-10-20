import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { BackgroundWork } from '@shared/background-work'
import { latestBackgroundWork } from '@shared/background-work'
import type { Turn } from '../format'
import { AssistantTurn } from './ChatTurn'
import { Sidebar } from './Sidebar'
import { OverviewPanel } from './OverviewPanel'
import { addRunningRunId } from '../App'
import { BackgroundWorkPanel, backgroundTaskAge } from './BackgroundWorkPanel'

const work: BackgroundWork = {
  providerId: 'qoder', phase: 'waiting', quiet: false, coverage: 'partial', taskStop: 'available', lastEventAt: 0,
  tasks: [{ taskId: 'task-1', toolUseId: 'call-1', tool: 'Bash', description: 'append journal', observedAt: 0 }]
}
const turn: Turn = { runId: 'run-1', userText: 'work', done: false, items: [
  { runId: 'run-1', id: 'text', ts: '', kind: 'model', stage: 'text', text: 'Model response' },
  { runId: 'run-1', id: 'work', ts: '', kind: 'harness', stage: 'runtime:background_work', backgroundWork: work }
] }

it('does not resurrect terminal membership from delayed session or focus announcements', () => {
  const terminal = new Set<string>()
  let running = addRunningRunId(new Set(), 'run', terminal)
  expect(running.has('run')).toBe(true)
  terminal.add('run')
  running = new Set()
  expect(addRunningRunId(running, 'run', terminal)).toBe(running)
  expect(terminal.has('run')).toBe(true)
  expect(addRunningRunId(running, 'new-run', terminal).has('new-run')).toBe(true)
})

it('does not conflate model waiting with generation, failure, or a completed turn', () => {
  const html = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)
  expect(html).toContain('等待后台任务')
  expect(html).toContain('停止任务 task-1')
  expect(html).not.toContain('class="skeleton"')
  expect(html).not.toContain('md streaming')
  const archived = renderToStaticMarkup(<AssistantTurn turn={{ ...turn, done: true }} selectedId={null} onSelect={() => {}} />)
  expect(archived).not.toContain('停止任务 task-1')
  expect(archived).not.toContain('后台任务长时间未更新')
})

it('shows Pi child waiting consistently without advertising Qoder task controls', () => {
  const piWork: BackgroundWork = { ...work, providerId: 'pi', taskStop: 'unavailable',
    tasks: [{ ...work.tasks[0], tool: 'Agent', description: 'worker' }] }
  const piTurn = { ...turn, items: turn.items.map(item => item.backgroundWork ? { ...item, backgroundWork: piWork } : item) }
  const html = renderToStaticMarkup(<AssistantTurn turn={piTurn} selectedId={null} onSelect={() => {}} />)
  expect(html).toContain('等待子 Agent')
  expect(html).toContain('worker')
  expect(html).toContain('等待结果')
  expect(html).not.toContain('不可单独停止')
  expect(html).not.toContain('不保证后台子 Agent 已停止')
  expect(html).not.toContain('停止任务 task-1')
  expect(html).not.toContain('当前 Qoder')
  const overview = renderToStaticMarkup(<OverviewPanel turns={[piTurn]} busy sessionId="pi-session"
    selected={null} usage={null} stats={null} onSelect={() => {}} />)
  expect(overview).toContain('等待子 Agent')
  expect(overview).not.toContain('轮次已结束')
})

it('uses the latest inactive snapshot instead of reopening an earlier waiting phase', () => {
  const items = [...turn.items, { backgroundWork: { ...work, phase: 'inactive' as const } }]
  expect(latestBackgroundWork(items)?.phase).toBe('inactive')
})

it('selects revision evidence rather than array position after trimmed snapshot recovery', () => {
  const old = { ...work, revision: 1 }
  const recent = { ...work, phase: 'working' as const, revision: 2 }
  const ended = { ...work, phase: 'inactive' as const, revision: 3 }
  expect(latestBackgroundWork([{ backgroundWork: recent }, { backgroundWork: old }])).toBe(recent)
  expect(latestBackgroundWork([{ backgroundWork: ended }, { backgroundWork: recent }])).toBe(ended)
})

it('keeps the approved compact identity and only two evidence fields, without explanatory copy', () => {
  const html = renderToStaticMarkup(<BackgroundWorkPanel runId="run" work={{ ...work, taskStop: 'unavailable' }} />)
  const summary = html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? ''
  expect(html).toContain('class="background-work-head"')
  expect(html).toContain('append journal</strong>')
  expect(html).toContain('Qoder')
  expect(html).toContain('等待结果')
  expect(summary).toContain('详情')
  expect(summary).not.toContain('task-1')
  expect(html).toContain('<details class="background-work-details">')
  expect(html.match(/<dt>/g)).toHaveLength(2)
  expect(html).toContain('<dt>任务 ID</dt>')
  expect(html).toContain('<code>task-1</code>')
  expect(html).toContain('<dt>回执时间</dt>')
  for (const removed of ['计时依据', '状态依据', '停止限制', '观测范围', '不可单独停止', '清单可能不完整']) {
    expect(html).not.toContain(removed)
  }
  expect(html).not.toContain('<button')
})

it('marks a task without confirmed runtime state as unknown instead of claiming execution or completion', () => {
  const html = renderToStaticMarkup(<BackgroundWorkPanel runId="run" work={{ ...work,
    tasks: [{ ...work.tasks[0], status: 'unconfirmed' }] }} />)
  expect(html).toContain('data-status="unknown"')
  expect(html).toContain('状态未知')
  expect(html).not.toContain('执行中')
  expect(html).not.toContain('已完成')
})

it('keeps quiet warnings and unconfirmed stop evidence visible without claiming termination', () => {
  const html = renderToStaticMarkup(<BackgroundWorkPanel runId="run" work={{ ...work, quiet: true,
    tasks: [{ ...work.tasks[0], stopState: 'unconfirmed' }] }} />)
  expect(html).toContain('停止待确认')
  expect(html).toContain('重试前请先核验')
  expect(html).not.toContain('已停止')
  expect(html).toContain('disabled=""')
})

it('does not render live task cards or controls for an inactive snapshot', () => {
  expect(renderToStaticMarkup(<BackgroundWorkPanel runId="run" work={{ ...work, phase: 'inactive' }} />)).toBe('')
})

it('keeps an unassociated wait honest without inventing task details or controls', () => {
  const html = renderToStaticMarkup(<BackgroundWorkPanel runId="run" work={{ ...work, tasks: [] }} />)
  expect(html).toContain('等待后续结果')
  expect(html).not.toContain('<button')
  expect(html).not.toContain('<details')
  expect(html).not.toContain('已完成')
})

it('formats observation age without inventing a process start time or invalid duration', () => {
  expect(backgroundTaskAge(0, 30_000)).toBe('<1m')
  expect(backgroundTaskAge(0, 240_000)).toBe('4m')
  expect(backgroundTaskAge(0, 3_900_000)).toBe('1h 5m')
  expect(backgroundTaskAge(NaN, 100)).toBeUndefined()
  expect(backgroundTaskAge(200, 100)).toBeUndefined()
})

it('projects waiting/quiet states only onto the corresponding live sidebar run', () => {
  const html = renderToStaticMarkup(<Sidebar
    projects={[{ cwd: '/fixture', name: 'fixture', mtime: 1, sessions: [
      { sessionId: 'one', runId: 'run-1', providerId: 'qoder', mtime: 1, preview: 'waiting', count: 1 },
      { sessionId: 'two', runId: 'done', providerId: 'qoder', mtime: 1, preview: 'done', count: 1 }
    ] }]}
    activeCwd="/fixture" activeProviderId="qoder" runningRunIds={new Set(['run-1'])}
    backgroundWorkByRun={{ 'run-1': { ...work, quiet: true }, done: work }}
    onNewChat={() => {}} onPick={() => {}} onTogglePin={() => {}} onArchive={() => {}}
  />)
  expect(html).toContain('aria-label="后台状态待确认"')
  expect(html.match(/data-background-waiting="true"/g)).toHaveLength(1)
  expect(html).not.toContain('aria-label="正在运行"')
})
