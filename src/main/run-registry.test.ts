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
    const state = { runId: 'run-a', done: false, providerSettled: false }
    registry.register(state, { runId: 'run-a' })

    state.done = true

    expect(registry.isFocused('run-a')).toBe(false)
    expect(registry.focusedState()).toBeNull()
    expect(registry.activeStates()).toEqual([])
    expect(registry.unsettledStates()).toEqual([state])

    state.providerSettled = true
    expect(registry.unsettledStates()).toEqual([])
  })

  // 终态 enrichment（turn_diff / session_diff）是在 runState.done 翻 true 之后才落的，
  // 那一刻 isFocused 已经是 false，但 registry entry 要到 runtime promise settle 才移除。
  it('done 之后不再 focused，但仍是 renderer 正在看的 run（终态 enrichment 可发布）', () => {
    const registry = new RunRegistry<
      { runId: string; done: boolean },
      { runId: string }
    >()
    const state = { runId: 'run-a', done: false }
    registry.register(state, { runId: 'run-a' })

    state.done = true

    expect(registry.isFocused('run-a')).toBe(false)
    expect(registry.isViewed('run-a')).toBe(true)

    registry.remove('run-a')
    expect(registry.isViewed('run-a')).toBe(false)
  })

  it('isViewed 不串会话：后台 run、切走的会话、未注册的 run 一律 false', () => {
    const registry = new RunRegistry<
      { runId: string; done: boolean },
      { runId: string }
    >()
    const background = { runId: 'run-bg', done: false }
    const current = { runId: 'run-cur', done: false }
    registry.register(background, { runId: 'run-bg' })
    registry.register(current, { runId: 'run-cur' })

    background.done = true
    current.done = true

    expect(registry.isViewed('run-bg')).toBe(false)
    expect(registry.isViewed('run-cur')).toBe(true)
    expect(registry.isViewed('run-missing')).toBe(false)

    registry.focus(null) // renderer 切到历史会话
    expect(registry.isViewed('run-cur')).toBe(false)
  })
})
