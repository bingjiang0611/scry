import { describe, expect, it, vi } from 'vitest'
import { RunRegistry } from './run-registry'

describe('RunRegistry', () => {
  it('按 runId 隔离控制器，停止目标查找不会串到其他 run', () => {
    const registry = new RunRegistry<
      { runId: string; done: boolean; prompt: string },
      { runId: string; interrupt: () => void }
    >()
    const interruptA = vi.fn()
    const interruptB = vi.fn()

    registry.register({ runId: 'run-a', done: false, prompt: 'A' }, { runId: 'run-a', interrupt: interruptA })
    registry.register({ runId: 'run-b', done: false, prompt: 'B' }, { runId: 'run-b', interrupt: interruptB })

    registry.get('run-a')?.control.interrupt()

    expect(interruptA).toHaveBeenCalledOnce()
    expect(interruptB).not.toHaveBeenCalled()
    expect(registry.activeStates().map((run) => run.runId)).toEqual(['run-a', 'run-b'])
  })

  it('切换焦点不删除后台 run，移除一个 run 也不影响另一个', () => {
    const registry = new RunRegistry<
      { runId: string; done: boolean },
      { runId: string }
    >()
    registry.register({ runId: 'run-a', done: false }, { runId: 'run-a' })
    registry.register({ runId: 'run-b', done: false }, { runId: 'run-b' })

    expect(registry.focus('run-a')).toBe(true)
    expect(registry.focusedState()?.runId).toBe('run-a')
    registry.remove('run-a')

    expect(registry.focusedState()).toBeNull()
    expect(registry.activeStates().map((run) => run.runId)).toEqual(['run-b'])
  })

  it('run 已终态但底层 promise 尚未 settle 时不再视为 focused', () => {
    const registry = new RunRegistry<
      { runId: string; done: boolean },
      { runId: string }
    >()
    const state = { runId: 'run-a', done: false }
    registry.register(state, { runId: 'run-a' })

    state.done = true

    expect(registry.isFocused('run-a')).toBe(false)
    expect(registry.focusedState()).toBeNull()
    expect(registry.activeStates()).toEqual([])
  })
})
