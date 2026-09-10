import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderBackgroundMonitor } from './qoder-background-work'
import { QoderBackgroundTasks } from './qoder-messages'
import type { BackgroundWork } from '../../shared/background-work'

function fixture() {
  const tasks = new QoderBackgroundTasks()
  const states: BackgroundWork[] = []
  const monitor = new QoderBackgroundMonitor(tasks, () => true, (work) => states.push(work))
  const send = (raw: Record<string, unknown>): void => { tasks.observe(raw); monitor.observe(raw, tasks.pending) }
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'call-1', input: { command: 'obsidian append', description: '写入日志' } }] } })
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Appended to log.md' }] }, tool_use_result: { kind: 'backgrounded', taskId: 'task-1' } })
  return { monitor, tasks, states, send }
}
afterEach(() => vi.useRealTimers())

describe('Qoder background state, not a task deadline', () => {
  it('distinguishes model end_turn from Provider completion even before any result', () => {
    vi.useFakeTimers()
    const f = fixture()
    expect(f.states.at(-1)).toMatchObject({ phase: 'working', tasks: [{ taskId: 'task-1', description: '写入日志' }] })
    f.send({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } })
    expect(f.states.at(-1)?.phase).toBe('waiting')
    vi.advanceTimersByTime(60 * 60_000)
    expect(f.states.at(-1)).toMatchObject({ phase: 'waiting', quiet: true, tasks: [{ taskId: 'task-1' }] })
    expect(f.tasks.pending).toBe(true)
    f.monitor.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not promote output text or spoofed/replayed notifications to task completion', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.send({ type: 'result', subtype: 'success' })
    for (const extra of [{ isReplay: true }, { tool_use_id: 'wrong' }]) {
      f.send({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', ...extra })
    }
    expect(f.tasks.pending).toBe(true)
    f.monitor.dispose()
  })

  it('ignores keepalives, resumes on progress, pauses for questions, and closes only on the follow-up result', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.send({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } })
    vi.advanceTimersByTime(14 * 60_000)
    f.send({ type: 'system', subtype: 'heartbeat' })
    vi.advanceTimersByTime(60_000)
    expect(f.states.at(-1)?.quiet).toBe(true)
    f.send({ type: 'system', subtype: 'task_progress', task_id: 'task-1' })
    expect(f.states.at(-1)?.quiet).toBe(false)
    f.monitor.pause()
    vi.advanceTimersByTime(60 * 60_000)
    expect(f.states.at(-1)?.quiet).toBe(false)
    f.monitor.resume()
    f.send({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'call-1', status: 'completed' })
    expect(f.states.at(-1)).toMatchObject({ phase: 'waiting', tasks: [] })
    f.send({ type: 'stream_event', event: { type: 'message_start' } })
    expect(f.states.at(-1)?.phase).toBe('working')
    f.send({ type: 'result', subtype: 'success' })
    expect(f.states.at(-1)?.phase).toBe('inactive')
    f.monitor.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('associates Agent receipts and preserves stop-request evidence until a matching terminal', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'local_agent', id: 'agent-call', input: { description: 'inspect' } }] } })
    f.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call' }] }, tool_use_result: { status: 'async_launched', taskId: 'agent-task' } })
    f.tasks.markStop('agent-task', 'requested')
    f.monitor.refresh()
    expect(f.states.at(-1)?.tasks).toContainEqual(expect.objectContaining({ taskId: 'agent-task', tool: 'Agent', stopState: 'requested' }))
    f.send({ type: 'system', subtype: 'task_updated', task_id: 'agent-task', patch: { status: 'stopped' } })
    expect(f.tasks.has('agent-task')).toBe(false)
    f.send({ type: 'system', subtype: 'task_notification', task_id: 'agent-task', status: 'stopped' })
    expect(f.tasks.has('agent-task')).toBe(false)
    expect(f.tasks.has('task-1')).toBe(true)
    f.monitor.dispose()
  })
})
