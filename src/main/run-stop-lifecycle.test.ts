import { describe, expect, it } from 'vitest'
import type { AgentStopState } from '../shared/runtime'
import { RunStopLifecycle, stopEscalationWindow, type StopLifecycleTarget } from './run-stop-lifecycle'

interface FakeClock {
  advance: (ms: number) => void
  schedule: (fn: () => void, ms: number) => () => void
  now: () => number
  pending: () => number
}

function fakeClock(): FakeClock {
  let current = 1_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => current,
    pending: () => timers.size,
    schedule: (fn, ms) => {
      const id = seq++
      timers.set(id, { at: current + ms, fn })
      return () => timers.delete(id)
    },
    advance: (ms) => {
      const target = current + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
        if (!due) break
        timers.delete(due[0])
        current = due[1].at
        due[1].fn()
      }
      current = target
    }
  }
}

function target(overrides: Partial<StopLifecycleTarget> = {}): StopLifecycleTarget & { interrupts: number; kills: number } {
  const calls = { interrupts: 0, kills: 0 }
  return {
    runId: 'run-1',
    providerId: 'claude',
    runtimeProvider: 'claude_sdk',
    agentProfileId: 'claude:default',
    interrupt: () => { calls.interrupts += 1 },
    forceKill: () => { calls.kills += 1 },
    forceKillScope: () => 'run_scoped',
    ...overrides,
    get interrupts() { return calls.interrupts },
    get kills() { return calls.kills }
  } as StopLifecycleTarget & { interrupts: number; kills: number }
}

function tracker(clock: FakeClock): { lifecycle: RunStopLifecycle; published: AgentStopState[] } {
  const published: AgentStopState[] = []
  const lifecycle = new RunStopLifecycle({
    publish: (state) => published.push(state),
    schedule: clock.schedule,
    now: clock.now
  })
  return { lifecycle, published }
}

describe('RunStopLifecycle', () => {
  it('never claims termination while the Provider is still unsettled', () => {
    const clock = fakeClock()
    const { lifecycle, published } = tracker(clock)
    const stuck = target()
    const window = stopEscalationWindow('claude_sdk')

    lifecycle.request(stuck)
    expect(published.map((state) => state.phase)).toEqual(['interrupt_requested'])
    expect(stuck.interrupts).toBe(1)
    expect(stuck.kills).toBe(0)
    expect(published.every((state) => state.providerSettled === false)).toBe(true)

    clock.advance(window.gracefulMs)
    expect(stuck.kills).toBe(1)
    expect(published.map((state) => state.phase)).toEqual(['interrupt_requested', 'force_kill_requested'])

    clock.advance(window.forceKillMs)
    expect(published.map((state) => state.phase)).toEqual([
      'interrupt_requested',
      'force_kill_requested',
      'provider_unsettled'
    ])
    // 未确认终止不是终态：providerSettled 必须仍然是 false，绝不冒充 settled。
    expect(published.at(-1)?.providerSettled).toBe(false)
    expect(clock.pending()).toBe(0)
  })

  it('stops escalating as soon as a cooperative stop settles', () => {
    const clock = fakeClock()
    const { lifecycle, published } = tracker(clock)
    const cooperative = target({ runId: 'run-2', providerId: 'codex', runtimeProvider: 'codex_cli' })

    lifecycle.request(cooperative)
    clock.advance(500)
    const settled = lifecycle.settle('run-2')

    expect(settled?.phase).toBe('settled')
    expect(settled?.providerSettled).toBe(true)
    expect(cooperative.kills).toBe(0)
    expect(published.map((state) => state.phase)).toEqual(['interrupt_requested', 'settled'])

    clock.advance(60_000)
    expect(cooperative.kills).toBe(0)
    expect(published).toHaveLength(2)
    expect(lifecycle.snapshot('run-2')).toBeUndefined()
  })

  it('keeps repeated stop requests idempotent and preserves the original escalation window', () => {
    const clock = fakeClock()
    const { lifecycle, published } = tracker(clock)
    const stuck = target({ runId: 'run-3', providerId: 'pi', runtimeProvider: 'pi_rpc' })
    const window = stopEscalationWindow('pi_rpc')

    lifecycle.request(stuck)
    clock.advance(window.gracefulMs - 1)
    lifecycle.request(stuck)
    expect(stuck.interrupts).toBe(1)
    expect(published.map((state) => state.phase)).toEqual(['interrupt_requested', 'interrupt_requested'])

    clock.advance(1)
    expect(stuck.kills).toBe(1)
    expect(published.at(-1)?.phase).toBe('force_kill_requested')
  })

  it('keeps escalating when the adapter interrupt throws', () => {
    const clock = fakeClock()
    const warnings: string[] = []
    const published: AgentStopState[] = []
    const lifecycle = new RunStopLifecycle({
      publish: (state) => published.push(state),
      schedule: clock.schedule,
      now: clock.now,
      warn: (message) => warnings.push(message)
    })
    let killed = 0
    lifecycle.request({
      runId: 'run-4',
      providerId: 'qoder',
      runtimeProvider: 'qoder_cli',
      interrupt: () => { throw new Error('adapter interrupt exploded') },
      forceKill: () => { killed += 1 },
      forceKillScope: () => 'run_scoped'
    })
    expect(warnings).toEqual(['stop interrupt failed'])
    clock.advance(stopEscalationWindow('qoder_cli').gracefulMs)
    expect(killed).toBe(1)
    expect(published.at(-1)?.phase).toBe('force_kill_requested')
  })

  it('cancels pending escalation on close', () => {
    const clock = fakeClock()
    const { lifecycle, published } = tracker(clock)
    const stuck = target({ runId: 'run-5' })
    lifecycle.request(stuck)
    lifecycle.close()
    clock.advance(60_000)
    expect(stuck.kills).toBe(0)
    expect(published).toHaveLength(1)
  })

  it('never hard-kills a shared transport that other concurrent runs depend on', () => {
    for (const runtime of ['codex_cli', 'opencode_server'] as const) {
      const clock = fakeClock()
      const { lifecycle, published } = tracker(clock)
      const shared = target({
        runId: `run-shared-${runtime}`,
        providerId: runtime === 'codex_cli' ? 'codex' : 'opencode',
        runtimeProvider: runtime,
        forceKillScope: () => 'shared_transport'
      })

      lifecycle.request(shared)
      clock.advance(stopEscalationWindow(runtime).gracefulMs)

      // 共享 transport 上的硬杀会杀掉无关 run：不得发出，也不得声称已发出。
      expect(shared.kills).toBe(0)
      expect(published.map((state) => state.phase)).toEqual(['interrupt_requested', 'no_safe_force_kill'])
      expect(published.at(-1)?.forceKillBlockReason).toBe('shared_transport')
      expect(published.at(-1)?.providerSettled).toBe(false)
      // 没有硬杀待确认，不再编一个等待窗口；真正的终止仍由 Provider settle 证明。
      expect(clock.pending()).toBe(0)
      clock.advance(60_000)
      expect(shared.kills).toBe(0)
      expect(published).toHaveLength(2)

      expect(lifecycle.settle(shared.runId)?.providerSettled).toBe(true)
      expect(published.at(-1)?.phase).toBe('settled')
    }
  })

  it('hard-kills only transports the adapter proves are run-scoped', () => {
    for (const [runtime, providerId] of [
      ['claude_sdk', 'claude'],
      ['qoder_cli', 'qoder'],
      ['pi_rpc', 'pi']
    ] as const) {
      const clock = fakeClock()
      const { lifecycle, published } = tracker(clock)
      const scoped = target({ runId: `run-scoped-${runtime}`, providerId, runtimeProvider: runtime })
      const window = stopEscalationWindow(runtime)

      lifecycle.request(scoped)
      clock.advance(window.gracefulMs)
      expect(scoped.kills).toBe(1)
      clock.advance(window.forceKillMs)
      expect(published.map((state) => state.phase)).toEqual([
        'interrupt_requested',
        'force_kill_requested',
        'provider_unsettled'
      ])
      expect(published.every((state) => state.providerSettled === false)).toBe(true)
    }
  })

  it('reads the force-kill scope at escalation time instead of trusting the request-time transport', () => {
    const clock = fakeClock()
    const { lifecycle, published } = tracker(clock)
    // 停止请求可能在 transport 建立前到达；升级时已经落到共享 client 上。
    let scope: 'run_scoped' | 'shared_transport' = 'run_scoped'
    const late = target({
      runId: 'run-late-transport',
      providerId: 'codex',
      runtimeProvider: 'codex_cli',
      forceKillScope: () => scope
    })

    lifecycle.request(late)
    scope = 'shared_transport'
    clock.advance(stopEscalationWindow('codex_cli').gracefulMs)

    expect(late.kills).toBe(0)
    expect(published.at(-1)?.phase).toBe('no_safe_force_kill')
  })

  it('fails closed when the adapter cannot report its force-kill scope', () => {
    const clock = fakeClock()
    const warnings: string[] = []
    const published: AgentStopState[] = []
    const lifecycle = new RunStopLifecycle({
      publish: (state) => published.push(state),
      schedule: clock.schedule,
      now: clock.now,
      warn: (message) => warnings.push(message)
    })
    let killed = 0
    lifecycle.request({
      runId: 'run-unknown-scope',
      providerId: 'opencode',
      runtimeProvider: 'opencode_server',
      interrupt: () => {},
      forceKill: () => { killed += 1 },
      forceKillScope: () => { throw new Error('scope unavailable') }
    })
    clock.advance(stopEscalationWindow('opencode_server').gracefulMs)

    expect(killed).toBe(0)
    expect(warnings).toEqual(['stop forceKillScope failed'])
    expect(published.at(-1)?.phase).toBe('no_safe_force_kill')
    expect(published.at(-1)?.forceKillBlockReason).toBe('scope_unavailable')
  })

  it('does not claim a hard kill before the Provider handle exists', () => {
    const clock = fakeClock()
    const { lifecycle, published } = tracker(clock)
    const notStarted = target({
      runId: 'run-handle-pending',
      forceKillScope: () => undefined
    })

    lifecycle.request(notStarted)
    clock.advance(stopEscalationWindow('claude_sdk').gracefulMs)

    expect(notStarted.kills).toBe(0)
    expect(published.at(-1)).toMatchObject({
      phase: 'no_safe_force_kill',
      forceKillBlockReason: 'scope_unavailable',
      providerSettled: false
    })
  })

  it('does not claim a hard kill when the run-scoped forceKill call throws', () => {
    const clock = fakeClock()
    const warnings: string[] = []
    const published: AgentStopState[] = []
    const lifecycle = new RunStopLifecycle({
      publish: (state) => published.push(state),
      schedule: clock.schedule,
      now: clock.now,
      warn: (message) => warnings.push(message)
    })
    lifecycle.request({
      runId: 'run-kill-failed',
      providerId: 'pi',
      runtimeProvider: 'pi_rpc',
      interrupt: () => {},
      forceKill: () => { throw new Error('kill failed') },
      forceKillScope: () => 'run_scoped'
    })

    clock.advance(stopEscalationWindow('pi_rpc').gracefulMs)

    expect(warnings).toEqual(['stop forceKill failed'])
    expect(published.at(-1)).toMatchObject({
      phase: 'no_safe_force_kill',
      forceKillBlockReason: 'force_kill_failed',
      providerSettled: false
    })
  })

  it('publishes provider-specific escalation windows for every runtime', () => {
    for (const runtime of ['claude_sdk', 'codex_cli', 'qoder_cli', 'opencode_server', 'pi_rpc'] as const) {
      const window = stopEscalationWindow(runtime)
      expect(window.gracefulMs).toBeGreaterThan(0)
      expect(window.forceKillMs).toBeGreaterThan(0)
    }
  })
})
