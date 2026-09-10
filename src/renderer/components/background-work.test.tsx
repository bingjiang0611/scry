import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { BackgroundWork } from '@shared/background-work'
import { latestBackgroundWork } from '@shared/background-work'
import type { Turn } from '../format'
import { AssistantTurn } from './ChatTurn'
import { Sidebar } from './Sidebar'

const work: BackgroundWork = {
  providerId: 'qoder', phase: 'waiting', quiet: false, coverage: 'partial', taskStop: 'available', lastEventAt: 0,
  tasks: [{ taskId: 'task-1', toolUseId: 'call-1', tool: 'Bash', description: 'append journal', observedAt: 0 }]
}
const turn: Turn = { runId: 'run-1', userText: 'work', done: false, items: [
  { runId: 'run-1', id: 'text', ts: '', kind: 'model', stage: 'text', text: 'Model response' },
  { runId: 'run-1', id: 'work', ts: '', kind: 'harness', stage: 'runtime:background_work', backgroundWork: work }
] }

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
