import { describe, expect, it, vi } from 'vitest'
import { observePiBackground } from './pi-background-wake'

const snapshot = (states: string[]): Record<string, unknown> => ({
  type: 'extension_ui_request',
  method: 'setWidget',
  widgetKey: 'subagent-async',
  widgetLines: ['PI_SUBAGENT_ASYNC_JSON:' + JSON.stringify({
    kind: 'pi-subagents.async-status-snapshot',
    version: 1,
    generatedAt: 1,
    runs: states.map((state, index) => ({ id: `child-${index + 1}`, kind: 'subagent', label: 'worker', state }))
  })]
})

function fakeRpc() {
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  return {
    onEvent(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send(event: Record<string, unknown>) { for (const listener of [...listeners]) listener(event) },
    get count() { return listeners.size }
  }
}

describe('observePiBackground', () => {
  it('wakes once when the extension resumes the parent', () => {
    const rpc = fakeRpc()
    const onWake = vi.fn()
    observePiBackground(rpc, { taskIds: ['child-1'], onWake })
    rpc.send({ type: 'agent_start' })
    rpc.send({ type: 'agent_start' })
    expect(onWake).toHaveBeenCalledTimes(1)
    expect(onWake).toHaveBeenCalledWith({ taskIds: ['child-1'], reason: 'continuation' })
    // Watching ends with the wake: the host owns the session again.
    expect(rpc.count).toBe(0)
  })

  it('wakes only when every task reached a terminal state', () => {
    const rpc = fakeRpc()
    const onWake = vi.fn()
    observePiBackground(rpc, { taskIds: ['child-1'], onWake })
    rpc.send(snapshot(['running']))
    expect(onWake).not.toHaveBeenCalled()
    rpc.send(snapshot(['running', 'complete']))
    expect(onWake).not.toHaveBeenCalled()
    rpc.send(snapshot(['complete']))
    expect(onWake).toHaveBeenCalledWith({ taskIds: ['child-1'], reason: 'terminal' })
  })

  it('treats a cleared widget as completion and an empty snapshot as an evidence gap', () => {
    const cleared = fakeRpc()
    const first = vi.fn()
    observePiBackground(cleared, { taskIds: ['child-1'], onWake: first })
    cleared.send({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async' })
    expect(first).toHaveBeenCalledWith({ taskIds: ['child-1'], reason: 'cleared' })

    const empty = fakeRpc()
    const second = vi.fn()
    observePiBackground(empty, { taskIds: ['child-1'], onWake: second })
    empty.send(snapshot([]))
    expect(second).not.toHaveBeenCalled()
  })

  it('stops watching when the caller stops or the bound elapses', () => {
    vi.useFakeTimers()
    try {
      const rpc = fakeRpc()
      const onWake = vi.fn()
      observePiBackground(rpc, { taskIds: ['child-1'], onWake, maxMs: 1_000 })
      vi.advanceTimersByTime(1_000)
      rpc.send({ type: 'agent_start' })
      expect(onWake).not.toHaveBeenCalled()
      expect(rpc.count).toBe(0)

      const stopped = fakeRpc()
      const other = vi.fn()
      observePiBackground(stopped, { taskIds: ['child-1'], onWake: other }).stop()
      stopped.send({ type: 'agent_start' })
      expect(other).not.toHaveBeenCalled()
      expect(stopped.count).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
