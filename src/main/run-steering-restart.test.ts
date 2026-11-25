import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { steerObservedRun } from './run-steering'

// C2: a provider without a verified native steer cannot accept a mid-turn message. Asking to
// restart means: stop this turn, keep the message for after it ends. It must never report the
// message as steered, and it must not stop the turn when the caller did not ask for a restart.

const sessionId = 'native-1'
const request = (extra: Record<string, unknown> = {}) => ({
  runId: 'run-1', messageId: 'msg-1', providerId: 'claude', cwd: '/w',
  prompt: 'hello', attachments: [], expectedExternalSessionId: sessionId,
  ...extra
})

const state = {
  runId: 'run-1', providerId: 'claude', agentProfileId: undefined, cwd: '/w',
  externalSessionId: sessionId, done: false, providerSettled: false, stopState: undefined
} as unknown as ActiveRun

function lookup(steer: (input: { messageId: string; prompt: string; attachments: unknown[] }) => Promise<import('../shared/runtime').AgentSteerResult>) {
  return (runId: string) => (runId === 'run-1' ? { state, control: { steer } } : undefined)
}

describe('steer falls back to interrupt-then-restart only when asked', () => {
  it('returns the provider refusal when the caller did not ask for a restart', async () => {
    const steer = vi.fn(async () => ({ status: 'unavailable' as const, message: '没有原生 Steer' }))
    const restart = vi.fn(() => true)
    await expect(steerObservedRun(request(), lookup(steer), { restart }))
      .resolves.toEqual({ status: 'unavailable', message: '没有原生 Steer' })
    expect(restart).not.toHaveBeenCalled()
  })

  it('stops the turn and says the message follows when a restart was requested', async () => {
    const steer = vi.fn(async () => ({ status: 'unavailable' as const, message: '没有原生 Steer' }))
    const restart = vi.fn(() => true)
    await expect(steerObservedRun(request({ restartWhenUnsupported: true }), lookup(steer), { restart }))
      .resolves.toEqual({ status: 'restarted', message: expect.stringContaining('本轮结束后') })
    expect(steer).toHaveBeenCalled()
    expect(restart).toHaveBeenCalledWith('run-1')
  })

  it('keeps the refusal when the stop is refused', async () => {
    const steer = vi.fn(async () => ({ status: 'unavailable' as const, message: '没有原生 Steer' }))
    const restart = vi.fn(() => false)
    await expect(steerObservedRun(request({ restartWhenUnsupported: true }), lookup(steer), { restart }))
      .resolves.toEqual({ status: 'unavailable', message: '没有原生 Steer' })
  })

  it('never restarts a provider that already steered', async () => {
    const steer = vi.fn(async () => ({ status: 'accepted' as const }))
    const restart = vi.fn(() => true)
    await expect(steerObservedRun(request({ restartWhenUnsupported: true }), lookup(steer), { restart }))
      .resolves.toEqual({ status: 'accepted' })
    expect(restart).not.toHaveBeenCalled()
  })
})
