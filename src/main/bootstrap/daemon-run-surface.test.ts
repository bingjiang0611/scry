import { describe, expect, it, vi } from 'vitest'
import type { DaemonRunTransport } from '../daemon-run-transport'
import type { DaemonRunRuntime } from '../daemon-run-runtime'
import { createDaemonRunSurface } from './daemon-run-surface'
import type { ActiveRun } from '../../shared/trace'

// The App's run controls in daemon mode. The registry is in the daemon, so these must
// become frames - and an answer the App cannot read must be reported, never shown as
// "sent".

const run = (runId: string): ActiveRun => ({ runId, state: 'running', providerId: 'claude', cwd: '/w', items: [] } as unknown as ActiveRun)

function surface(overrides: Partial<DaemonRunTransport> & { live?: ActiveRun[] } = {}) {
  const frames: Array<Record<string, unknown>> = []
  const transport = {
    runControl: vi.fn(async (request: Record<string, unknown>) => {
      frames.push(request)
      if (request.method === 'steer') return { steer: { status: 'accepted', messageId: 'm-1' } }
      if (request.method === 'stopBackgroundTask') return { backgroundTask: { status: 'requested', message: '' } }
      if (request.runId === 'run-abc-1') return { run: run('run-abc-1') }
      return { run: null }
    }),
    liveRuns: vi.fn(async () => ({ runs: overrides.live ?? [] }))
  } as unknown as DaemonRunTransport
  const runtime = {
    activeRuns: () => (overrides.live ?? []),
    isTracking: () => true,
    adopt: vi.fn(async () => undefined)
  } as unknown as DaemonRunRuntime
  return { value: createDaemonRunSurface({ transport, runtime, currentCwd: () => '/w' }), frames }
}

describe('daemon run surface controls', () => {
  it('forwards a steer to the daemon that owns the run', async () => {
    const { value, frames } = surface()
    await expect(value.steer({ runId: 'run-abc-1', messageId: 'm-1', prompt: 'go' }))
      .resolves.toEqual({ status: 'accepted', messageId: 'm-1' })
    expect(frames[0]).toEqual({ method: 'steer', payload: { runId: 'run-abc-1', messageId: 'm-1', prompt: 'go' } })
  })

  it('forwards a background-task stop and keeps the daemon wording', async () => {
    const { value, frames } = surface()
    await expect(value.stopBackgroundTask({ runId: 'run-abc-1', taskId: 't-1' }))
      .resolves.toEqual({ status: 'requested', message: '' })
    expect(frames[0]).toEqual({ method: 'stopBackgroundTask', payload: { runId: 'run-abc-1', taskId: 't-1' } })
  })

  it('adopts a live run and shows it afterwards', async () => {
    const { value, frames } = surface({ live: [run('run-abc-1'), run('run-def-2')] })
    await expect(value.adopt('run-abc-1')).resolves.toMatchObject({ runId: 'run-abc-1' })
    expect(frames[0]).toEqual({ method: 'adopt', runId: 'run-abc-1' })
    // Adopting is a view decision: the focused read now answers with that run.
    await expect(value.focusedRunSnapshot()).resolves.toMatchObject({ runId: 'run-abc-1' })
  })

  it('reports a run the daemon no longer knows as absent, not as adopted', async () => {
    const { value } = surface()
    await expect(value.adopt('run-def-2')).resolves.toBeNull()
  })

  it('refuses an answer it cannot read instead of inventing a control result', async () => {
    const transport = { runControl: vi.fn(async () => ({ steer: { nothing: true } })) } as unknown as DaemonRunTransport
    const runtime = { activeRuns: () => [] } as unknown as DaemonRunRuntime
    const value = createDaemonRunSurface({ transport, runtime, currentCwd: () => undefined })
    await expect(value.steer({ runId: 'run-abc-1' })).rejects.toThrow('daemon_run_control_unavailable')
  })
})
