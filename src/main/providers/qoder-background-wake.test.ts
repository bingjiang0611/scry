import { describe, expect, it, vi } from 'vitest'
import { QoderBackgroundTasks } from './qoder-messages'
import { observeQoderBackground } from './qoder-background-wake'

// C3 (Qoder): the answer ends the turn; the session's reader keeps reporting the child, and the last
// report must become exactly one wake. A message that does not settle the child must not.

// Qoder establishes a background task only from a structured launch receipt: a Bash/Agent tool_use,
// then the tool_result that says it went to the background with that task id.
const launch = (taskId: string, toolUseId: string): Record<string, unknown>[] => [
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 1' } }] }
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
    tool_use_result: { kind: 'backgrounded', taskId }
  }
]
const done = (taskId: string): Record<string, unknown> => ({
  type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed'
})

function harness(taskIds: string[] = ['child-1']) {
  const listeners = new Set<(message: Record<string, unknown>) => void>()
  const tasks = new QoderBackgroundTasks()
  const onWake = vi.fn()
  const watch = observeQoderBackground({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    tasks,
    taskIds,
    onWake
  })
  const emit = (message: Record<string, unknown>): void => { for (const listener of [...listeners]) listener(message) }
  return { watch, tasks, onWake, emit, listeners }
}

describe('Qoder background wake', () => {
  it('wakes once with the child that the settled turn left running', () => {
    const { onWake, emit, watch } = harness()
    for (const message of launch('child-1', 'tool-1')) emit(message)
    // Still running: nothing to report yet, and the run must not be reopened by a progress note.
    emit({ type: 'system', subtype: 'task_progress', task_id: 'child-1' })
    expect(onWake).not.toHaveBeenCalled()
    emit(done('child-1'))
    expect(onWake).toHaveBeenCalledTimes(1)
    expect(onWake.mock.calls[0][0]).toEqual({ taskIds: ['child-1'] })
    // The watch is spent: a second terminal report must not wake the session twice.
    emit(done('child-1'))
    expect(onWake).toHaveBeenCalledTimes(1)
    watch.stop()
  })

  it('picks up a child the answer never named', () => {
    const { onWake, emit } = harness([])
    for (const message of launch('late-child', 'tool-9')) emit(message)
    expect(onWake).not.toHaveBeenCalled()
    emit(done('late-child'))
    expect(onWake).toHaveBeenCalledWith({ taskIds: ['late-child'] })
  })

  it('stays silent when no child was ever reported', () => {
    const { onWake, emit } = harness([])
    emit({ type: 'result', subtype: 'success' })
    expect(onWake).not.toHaveBeenCalled()
  })

  it('names every child of a settled turn when all of them finish', () => {
    const { onWake, emit } = harness(['a', 'b'])
    for (const message of launch('a', 'tool-a')) emit(message)
    for (const message of launch('b', 'tool-b')) emit(message)
    emit(done('a'))
    // One child left: a wake here would tell the next turn the work is done when it is not.
    expect(onWake).not.toHaveBeenCalled()
    emit(done('b'))
    expect(onWake).toHaveBeenCalledWith({ taskIds: ['a', 'b'] })
  })

  it('stops cleanly and never wakes after stop', () => {
    const { onWake, emit, watch, listeners } = harness()
    watch.stop()
    expect(listeners.size).toBe(0)
    emit(done('child-1'))
    expect(onWake).not.toHaveBeenCalled()
  })
})
