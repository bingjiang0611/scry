import { describe, expect, it, vi } from 'vitest'
import { createRemoteRunBinding } from './remote-run-binding'
import type { ProviderRunHandle, ProviderRunRequest } from '../providers/types'
import type { TraceEvent } from '../../shared/trace'

// A controllable fake of providerRegistry.run: it never spawns a CLI. The test
// drives emit/promise so we can assert the seam's wiring, progress mapping and
// terminal handling without real Provider cost.
function fakeRun(script: (req: ProviderRunRequest) => Promise<{ status?: 'completed' | 'failed' | 'cancelled' | 'interrupted' }>) {
  const calls: ProviderRunRequest[] = []
  const run = (_providerId: string, request: ProviderRunRequest): ProviderRunHandle => {
    calls.push(request)
    return {
      promise: script(request).then(r => ({ ...r })),
      interrupt: () => {},
      forceKill: () => {},
      forceKillScope: 'run_scoped',
      getExternalSessionId: () => undefined
    }
  }
  return { run, calls }
}

const result = (isError: boolean): TraceEvent => ({
  id: 'r', ts: '2020', runId: 'x', kind: 'harness', stage: 'result', isError,
  tokensIn: 11, tokensOut: 22, costUsd: 0.5
})
const controls = (): TraceEvent => ({ id: 'c', ts: '2020', runId: 'x', kind: 'harness', stage: 'runtime:controls' })

describe('remote run binding (live seam; no Provider process is spawned)', () => {
  it('runs the routed provider once and reports a truthful settled lifecycle', async () => {
    const { run, calls } = fakeRun(async (req) => { req.emit(controls()); req.emit(result(false)); return { status: 'completed' } })
    const progress = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-1' })
    await start({ runId: 'ledger-1', routing: { cwd: '/w', providerId: 'claude', agentProfileId: 'p', prompt: '  hi  ' }, progress })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ runId: 'scry-1', prompt: 'hi', cwd: '/w', agentProfileId: 'p', attachments: [] })
    // Native defaults preserved: no silent approval-mode escalation.
    expect(calls[0].permissionMode).toBeUndefined()
    expect(calls[0].model).toBeUndefined()

    const markers = progress.mock.calls.map(c => JSON.parse(c[0] as string))
    expect(markers[0]).toEqual({ event: 'bound', ledgerRunId: 'ledger-1', scryRunId: 'scry-1', providerId: 'claude', cwd: '/w' })
    expect(markers).toContainEqual({ event: 'started' })
    expect(markers).toContainEqual({ event: 'result', isError: false, tokensIn: 11, tokensOut: 22, costUsd: 0.5 })
    expect(markers.at(-1)).toEqual({ event: 'settled', status: 'completed' })
  })

  it('rejects (ledger markFailed) when the provider result is a failure, surfacing its message', async () => {
    const { run } = fakeRun(async (req) => {
      req.emit({ ...result(true), text: 'boom detail' }); return { status: 'failed' }
    })
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-2' })
    await expect(start({ runId: 'l', routing: { cwd: '/w', providerId: 'codex', prompt: 'go' }, progress: () => {} }))
      .rejects.toThrow('provider_run_failed: boom detail')
  })

  it('fails closed on an empty prompt without ever invoking the provider', async () => {
    const { run, calls } = fakeRun(async () => ({ status: 'completed' }))
    const start = createRemoteRunBinding({ run })
    await expect(start({ runId: 'l', routing: { cwd: '/w', providerId: 'claude', prompt: '   ' }, progress: () => {} }))
      .rejects.toThrow('remote_run_missing_prompt')
    expect(calls).toHaveLength(0)
  })

  it('fails closed (never auto-approves) when the provider asks an interactive question', async () => {
    let thrown: unknown
    const { run } = fakeRun(async (req) => {
      try { await req.requestUserInput!({} as never, new AbortController().signal) } catch (e) { thrown = e }
      return { status: 'completed' }
    })
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-3' })
    await start({ runId: 'l', routing: { cwd: '/w', providerId: 'claude', prompt: 'q' }, progress: () => {} })
    expect((thrown as Error).message).toBe('remote_interactive_input_unsupported')
  })
})
