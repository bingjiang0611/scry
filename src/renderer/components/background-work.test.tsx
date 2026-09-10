import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { BackgroundWork } from '@shared/background-work'
import { latestBackgroundWork } from '@shared/background-work'
import type { Turn } from '../format'
import { AssistantTurn } from './ChatTurn'
import { Sidebar } from './Sidebar'
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

it('keeps technical evidence behind a collapsed task disclosure and exposes only supported actions', () => {
  const html = renderToStaticMarkup(<BackgroundWorkPanel runId="run" work={{ ...work, taskStop: 'unavailable' }} />)
  const summary = html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? ''
  expect(summary).toContain('append journal')
  expect(summary).toContain('执行中')
  expect(summary).not.toContain('task-1')
  expect(summary).not.toContain('未验证')
  expect(html).toContain('<details class="background-work-details">')
  expect(html).toContain('清单可能不完整')
  expect(html).not.toContain('<button')
})

it('keeps quiet warnings and unconfirmed stop evidence visible without claiming termination', () => {
  const html = renderToStaticMarkup(<BackgroundWorkPanel runId="run" work={{ ...work, quiet: true,
    tasks: [{ ...work.tasks[0], stopState: 'unconfirmed' }] }} />)
  expect(html).toContain('停止待确认')
  expect(html).toContain('重试前请先核验')
  expect(html).not.toContain('已停止')
  expect(html).toContain('disabled=""')
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
