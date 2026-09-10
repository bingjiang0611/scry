import { expect, it, vi } from 'vitest'
import { stopObservedBackgroundTask } from './background-task-control'
import type { TraceEvent } from '../shared/trace'

it('authorizes only a live Qoder run and its observed, stoppable task', async () => {
  const stopBackgroundTask = vi.fn().mockResolvedValue({ status: 'requested', message: 'requested' })
  const work = {
    providerId: 'qoder', phase: 'waiting', coverage: 'partial', taskStop: 'available', quiet: false, lastEventAt: 0,
    tasks: [{ taskId: 'task-1', toolUseId: 'call', tool: 'Bash', description: 'write', observedAt: 0 }]
  } as const
  const state = { done: false, providerId: 'qoder', items: [{ backgroundWork: { ...work, tasks: [...work.tasks] } }] as TraceEvent[] }
  const lookup = (runId: string) => runId === 'run-1' ? { state, control: { stopBackgroundTask } } : undefined
  for (const payload of [null, {}, { runId: 1, taskId: 'task-1' }, { runId: 'wrong-run', taskId: 'task-1' }, { runId: 'run-1', taskId: 'other-task' }, { runId: 'run-1', taskId: 'x'.repeat(257) }]) {
    expect(await stopObservedBackgroundTask(payload, lookup)).toMatchObject({ status: 'rejected' })
  }
  state.done = true
  expect(await stopObservedBackgroundTask({ runId: 'run-1', taskId: 'task-1' }, lookup)).toMatchObject({ status: 'rejected' })
  state.done = false
  state.providerId = 'claude'
  expect(await stopObservedBackgroundTask({ runId: 'run-1', taskId: 'task-1' }, lookup)).toMatchObject({ status: 'rejected' })
  expect(stopBackgroundTask).not.toHaveBeenCalled()
  state.providerId = 'qoder'
  expect(await stopObservedBackgroundTask({ runId: 'run-1', taskId: 'task-1' }, lookup)).toMatchObject({ status: 'requested' })
  expect(stopBackgroundTask).toHaveBeenCalledExactlyOnceWith('task-1')
})
