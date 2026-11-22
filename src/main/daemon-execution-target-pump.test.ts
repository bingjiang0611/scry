import { describe, expect, it, vi } from 'vitest'
import { DaemonExecutionTargetPump, type ExecutionTargetWorkCall, type ExecutionTargetWorkSource } from './daemon-execution-target-pump'
import { DaemonRunError, DaemonRunTransport } from './daemon-run-transport'
import { DEFAULT_MAX_FRAME } from './remote/inner-mtls-protocol'

describe('DaemonExecutionTargetPump', () => {
  it('pulls queued calls, executes them against DesktopRemoteTargetAPI concurrently, and reports results', async () => {
    let releaseFirst: (() => void) | undefined
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })
    const batches: ExecutionTargetWorkCall[][] = [
      [
        {
          callId: 'c1',
          method: 'mobileRequest',
          input: { target: { id: 't1', binding: 'b'.repeat(64) }, request: { op: 'watch', runId: 'r1', cursor: 0, outputCursor: 0, waitMs: 5000 } }
        },
        { callId: 'c2', method: 'executionTargets', input: {} }
      ]
    ]
    const results: Array<Record<string, unknown>> = []
    let finishResults!: () => void
    const allResults = new Promise<void>((resolve) => { finishResults = resolve })
    let pollCount = 0
    const source: ExecutionTargetWorkSource = {
      executionTargetWork: vi.fn(async (_input, signal) => {
        pollCount++
        if (batches.length > 0) return { calls: batches.shift()! }
        return await new Promise<{ calls: ExecutionTargetWorkCall[] }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }),
      executionTargetResult: vi.fn(async (input) => {
        results.push(input as unknown as Record<string, unknown>)
        if (results.length === 2) finishResults()
        return { accepted: true }
      })
    }
    const client = {
      executionTargets: vi.fn(async () => [{ id: 't1', binding: 'b'.repeat(64), hostId: 'h2', label: 'Mac2', state: 'connected' as const }]),
      mobileRequest: vi.fn(async () => {
        firstStarted()
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return { watch: { state: 'running' } }
      }),
      mobileSubmit: vi.fn(async () => ({ runId: 'r', status: 'recorded' })),
      mobileIntentStatus: vi.fn(async () => ({ intent: { runId: 'r', state: 'recorded' } }))
    }

    const pump = new DaemonExecutionTargetPump({ source, client: () => client, waitMs: 1_000 })
    pump.start()
    await firstStartedPromise
    // c2 (executionTargets) must complete while c1 (watch) is still blocked!
    await vi.waitFor(() => expect(results.some((r) => r.callId === 'c2')).toBe(true))
    releaseFirst?.()
    await allResults
    pump.dispose()

    expect(pollCount).toBeGreaterThanOrEqual(2)
    expect(results).toContainEqual({
      callId: 'c2',
      ok: true,
      result: [{ id: 't1', binding: 'b'.repeat(64), hostId: 'h2', label: 'Mac2', state: 'connected' }]
    })
    expect(results).toContainEqual({
      callId: 'c1',
      ok: true,
      result: { watch: { state: 'running' } }
    })
  })

  it('rejects oversized replies with execution_target_response_too_large before sending', async () => {
    const results: Array<Record<string, unknown>> = []
    let done!: () => void
    const finished = new Promise<void>((resolve) => { done = resolve })
    let sent = false
    const source: ExecutionTargetWorkSource = {
      executionTargetWork: vi.fn(async (_input, signal) => {
        if (!sent) {
          sent = true
          return { calls: [{ callId: 'big', method: 'mobileRequest' as const, input: { target: { id: 't1', binding: 'b'.repeat(64) }, request: { op: 'projects' } } }] }
        }
        return await new Promise<{ calls: ExecutionTargetWorkCall[] }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }),
      executionTargetResult: vi.fn(async (input) => {
        results.push(input as unknown as Record<string, unknown>)
        done()
        return { accepted: true }
      })
    }
    const client = {
      executionTargets: vi.fn(async () => []),
      mobileRequest: vi.fn(async () => ({ blob: 'x'.repeat(DEFAULT_MAX_FRAME) })),
      mobileSubmit: vi.fn(async () => ({})),
      mobileIntentStatus: vi.fn(async () => ({}))
    }
    const pump = new DaemonExecutionTargetPump({ source, client: () => client })
    pump.start()
    await finished
    pump.dispose()

    expect(results).toEqual([{ callId: 'big', ok: false, error: 'execution_target_response_too_large' }])
  })

  it('stops cleanly when an older daemon reports daemon_run_control_unavailable', async () => {
    const onWarn = vi.fn()
    const source: ExecutionTargetWorkSource = {
      executionTargetWork: vi.fn(async () => { throw new DaemonRunError('daemon_run_control_unavailable') }),
      executionTargetResult: vi.fn(async () => ({ accepted: true }))
    }
    const pump = new DaemonExecutionTargetPump({
      source,
      client: () => ({ executionTargets: async () => [], mobileRequest: async () => ({}), mobileSubmit: async () => ({}), mobileIntentStatus: async () => ({}) }),
      onWarn
    })
    pump.start()
    await vi.waitFor(() => expect(onWarn).toHaveBeenCalledTimes(1))
    expect(source.executionTargetWork).toHaveBeenCalledTimes(1)
    pump.dispose()
  })

  it('scopes unknown_op -> daemon_run_control_unavailable strictly to execution-target ops', async () => {
    const transport = new DaemonRunTransport(async () => ({ error: 'unknown_op' }))
    await expect(transport.executionTargetWork({ waitMs: 0 })).rejects.toMatchObject({ reason: 'daemon_run_control_unavailable' })
    await expect(transport.executionTargetResult({ callId: 'c1', ok: true })).rejects.toMatchObject({ reason: 'daemon_run_control_unavailable' })
    // Existing ops (e.g. appEvents for DaemonEventPump) keep invalid_daemon_response on unknown_op.
    await expect(transport.subscribe({ views: ['activeRuns'], waitMs: 0 })).rejects.toMatchObject({ reason: 'invalid_daemon_response' })
  })

  it('dispatches bridged shellOpenPath and shellTrashItem to App shellOps and rejects invalid paths (W17)', async () => {
    const batches: ExecutionTargetWorkCall[][] = [[
      { callId: 's1', method: 'shellOpenPath', input: { path: '/workspace/a.txt' } },
      { callId: 's2', method: 'shellTrashItem', input: { path: '/workspace/b.txt' } },
      { callId: 's3', method: 'shellOpenPath', input: { path: '/workspace/bad\0path' } }
    ]]
    const results: Array<Record<string, unknown>> = []
    let done!: () => void
    const finished = new Promise<void>((resolve) => { done = resolve })
    const source: ExecutionTargetWorkSource = {
      executionTargetWork: vi.fn(async (_input, signal) => {
        if (batches.length > 0) return { calls: batches.shift()! }
        return await new Promise<{ calls: ExecutionTargetWorkCall[] }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }),
      executionTargetResult: vi.fn(async (input) => {
        results.push(input as unknown as Record<string, unknown>)
        if (results.length === 3) done()
        return { accepted: true }
      })
    }
    const openPath = vi.fn(async () => undefined)
    const trashItem = vi.fn(async () => undefined)
    const pump = new DaemonExecutionTargetPump({ source, shellOps: { openPath, trashItem }, waitMs: 1_000 })
    pump.start()
    await finished
    pump.dispose()

    expect(openPath).toHaveBeenCalledExactlyOnceWith('/workspace/a.txt')
    expect(trashItem).toHaveBeenCalledExactlyOnceWith('/workspace/b.txt')
    expect(results).toContainEqual({ callId: 's1', ok: true, result: null })
    expect(results).toContainEqual({ callId: 's2', ok: true, result: null })
    expect(results).toContainEqual({ callId: 's3', ok: false, error: 'invalid_workbench_request' })
  })

  it('rejects an unknown work method without touching shell ops or the remote client', async () => {
    const batches = [[{ callId: 'u1', method: 'shellRunCommand', input: { path: '/workspace/a.txt' } }]] as unknown as ExecutionTargetWorkCall[][]
    const results: Array<Record<string, unknown>> = []
    let done!: () => void
    const finished = new Promise<void>((resolve) => { done = resolve })
    const source: ExecutionTargetWorkSource = {
      executionTargetWork: vi.fn(async (_input, signal) => {
        if (batches.length > 0) return { calls: batches.shift()! }
        return await new Promise<{ calls: ExecutionTargetWorkCall[] }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }),
      executionTargetResult: vi.fn(async (input) => {
        results.push(input as unknown as Record<string, unknown>)
        done()
        return { accepted: true }
      })
    }
    const openPath = vi.fn(async () => undefined)
    const trashItem = vi.fn(async () => undefined)
    const client = {
      executionTargets: vi.fn(), mobileRequest: vi.fn(), mobileSubmit: vi.fn(), mobileIntentStatus: vi.fn()
    }
    const pump = new DaemonExecutionTargetPump({
      source, shellOps: { openPath, trashItem }, client: () => client as never, waitMs: 1_000
    })
    pump.start()
    await finished
    pump.dispose()

    expect(results).toEqual([{ callId: 'u1', ok: false, error: 'invalid_target_request' }])
    expect(openPath).not.toHaveBeenCalled()
    expect(trashItem).not.toHaveBeenCalled()
    for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled()
  })
})
