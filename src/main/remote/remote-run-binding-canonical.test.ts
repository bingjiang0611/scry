import { describe, expect, it, vi } from 'vitest'
import { createRemoteRunBinding } from './remote-run-binding'
import type { TraceEvent } from '../../shared/trace'

// The canonical seam: a submitted run is handed to the App's own run lifecycle. These
// tests never spawn a Provider; the lifecycle is a fake that reports what it recorded.

const textEvent = (text: string): TraceEvent => ({ id: 't', ts: '2020', runId: 'x', kind: 'model', stage: 'text', text })

describe('remote run binding (canonical App seam: submit -> startAppRun)', () => {
  it('delegates production execution to the canonical App run lifecycle and preserves recording failure', async () => {
    const startAppRun = vi.fn(async (input: Parameters<NonNullable<import('./remote-run-binding').RemoteRunBindingDependencies['startAppRun']>>[0]) => {
      input.onTraceEvent(textEvent('canonical output'))
      return { status: 'completed' as const, recording: 'failed' as const, error: 'archive failed' }
    })
    const output = vi.fn()
    const start = createRemoteRunBinding({ startAppRun, nextScryRunId: () => 'canonical-1' })
    await expect(start({
      runId: 'ledger-canonical', routing: { cwd: '/w', providerId: 'claude', prompt: 'go' },
      progress: vi.fn(), output
    })).rejects.toThrow('archive failed')
    expect(startAppRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'canonical-1', ledgerRunId: 'ledger-canonical', request: expect.objectContaining({ prompt: 'go', cwd: '/w' })
    }))
    expect(output).toHaveBeenCalledWith({ kind: 'output', text: 'canonical output' })
  })

  it('tells the App this run arrived through the ledger', async () => {
    // `origin: 'remote'` is what makes the run keep ledger semantics (and, with a
    // device grant, the stricter ones). Without it the App treats a submitted run as
    // its own: it would register the Provider's question on the window's broker, which
    // a daemon does not have, and no client could ever answer it.
    const startAppRun = vi.fn(async (_input: { origin: 'remote'; grantScope?: 'local' | 'remote' }) => ({
      status: 'completed' as const, recording: 'committed' as const
    }))
    const start = createRemoteRunBinding({ startAppRun, nextScryRunId: () => 'canonical-origin' })
    await start({
      runId: 'ledger-origin', routing: { cwd: '/w', providerId: 'codex', prompt: 'go' },
      progress: () => {}, output: () => {}, grantScope: 'remote'
    })
    expect(startAppRun.mock.calls[0]![0]).toMatchObject({ origin: 'remote', grantScope: 'remote' })
  })

  it('passes an unnamed App submit through without inventing a directory', async () => {
    const startAppRun = vi.fn(async (input: Parameters<NonNullable<import('./remote-run-binding').RemoteRunBindingDependencies['startAppRun']>>[0]) => {
      input.onTraceEvent(textEvent('ok'))
      return { status: 'completed' as const, recording: 'committed' as const }
    })
    const start = createRemoteRunBinding({ startAppRun, nextScryRunId: () => 'canonical-unnamed' })
    await start({
      runId: 'ledger-unnamed', routing: { cwd: '', providerId: 'claude', prompt: 'go' },
      progress: () => {}, output: () => {}, grantScope: 'local'
    })
    const request = startAppRun.mock.calls[0]![0].request
    // Absent, not '': the App's own fallback to its current workspace only runs when
    // the request carries no directory at all.
    expect('cwd' in request).toBe(false)
    expect(request.prompt).toBe('go')
  })

  it('forwards an App turn boundary into the canonical run request', async () => {
    // The App edits its last message by forking that turn. Dropping the boundary would
    // run a fresh turn in the same session, which is not what the user asked for.
    const startAppRun = vi.fn(async (input: { request: { forkLastTurn?: unknown } }) => {
      expect(input.request.forkLastTurn).toEqual({
        replaceRunId: 'run-a', replaceProviderTurnId: 'turn-a', replaceForkTurnId: 'message-a'
      })
      return { status: 'completed' as const, recording: 'committed' as const }
    })
    const start = createRemoteRunBinding({ startAppRun, nextScryRunId: () => 'canonical-fork' })
    await start({
      runId: 'ledger-fork',
      routing: {
        cwd: '', providerId: 'claude', prompt: 'go', expectedExternalSessionId: 'session-1',
        forkLastTurn: { replaceRunId: 'run-a', replaceProviderTurnId: 'turn-a', replaceForkTurnId: 'message-a' }
      },
      progress: () => {}, output: () => {}, grantScope: 'local'
    })
    expect(startAppRun).toHaveBeenCalledTimes(1)
  })

  it('propagates canonical startup rejection as a failed remote lifecycle', async () => {
    const progress = vi.fn()
    const startAppRun = vi.fn(async () => { throw new Error('canonical startup failed') })
    const start = createRemoteRunBinding({ startAppRun, nextScryRunId: () => 'canonical-rejected' })
    await expect(start({
      runId: 'ledger-rejected', routing: { cwd: '/w', providerId: 'claude', prompt: 'go' },
      progress, output: () => {}
    })).rejects.toThrow('canonical startup failed')
    expect(progress.mock.calls.map(call => JSON.parse(call[0] as string)).at(-1)).toEqual({ event: 'settled', status: 'failed' })
  })

})
