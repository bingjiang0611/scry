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
const textEvent = (text: string): TraceEvent => ({ id: 't', ts: '2020', runId: 'x', kind: 'model', stage: 'text', text })
const thinkingEvent = (thinking: string): TraceEvent => ({ id: 'k', ts: '2020', runId: 'x', kind: 'model', stage: 'thinking', thinking })
const toolUse = (tool: string, filePath?: string): TraceEvent => ({ id: 'u', ts: '2020', runId: 'x', kind: 'tool', stage: `tool:${tool}`, tool, toolUseId: 'tu1', ...(filePath ? { filePath } : {}) })
const toolResult = (output: string): TraceEvent => ({ id: 'o', ts: '2020', runId: 'x', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu1', output })

describe('remote run binding (live seam; no Provider process is spawned)', () => {
  it('runs the routed provider once and reports a truthful settled lifecycle', async () => {
    const { run, calls } = fakeRun(async (req) => { req.emit(controls()); req.emit(result(false)); return { status: 'completed' } })
    const progress = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-1' })
    await start({ runId: 'ledger-1', routing: { cwd: '/w', providerId: 'claude', agentProfileId: 'p', prompt: '  hi  ' }, progress, output: () => {} })

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

  it('surfaces the run to the Mac catalog: onRunStarted at bind, onRunSession with the real externalSessionId', async () => {
    const { run } = fakeRun(async (req) => {
      req.onExternalSessionId?.('ext-abc')
      req.emit(controls()); req.emit(result(false)); return { status: 'completed' }
    })
    const onRunStarted = vi.fn()
    const onRunSession = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-cat', onRunStarted, onRunSession })
    await start({ runId: 'ledger-cat', routing: { cwd: '/w', providerId: 'qoder', agentProfileId: 'p', prompt: '  hi  ' }, progress: () => {}, output: () => {} })
    // Pending catalog entry at bind (visible on the Mac before the session id).
    expect(onRunStarted).toHaveBeenCalledWith({ providerId: 'qoder', cwd: '/w', prompt: 'hi', scryRunId: 'scry-cat', agentProfileId: 'p' })
    // Resolved to the Provider's REAL resumable session id.
    expect(onRunSession).toHaveBeenCalledWith({ providerId: 'qoder', cwd: '/w', prompt: 'hi', scryRunId: 'scry-cat', externalSessionId: 'ext-abc', agentProfileId: 'p' })
  })

  it('rejects (ledger markFailed) when the provider result is a failure, surfacing its message', async () => {
    const { run } = fakeRun(async (req) => {
      req.emit({ ...result(true), text: 'boom detail' }); return { status: 'failed' }
    })
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-2' })
    await expect(start({ runId: 'l', routing: { cwd: '/w', providerId: 'codex', prompt: 'go' }, progress: () => {}, output: () => {} }))
      .rejects.toThrow('provider_run_failed: boom detail')
  })

  it('fails closed on an empty prompt without ever invoking the provider', async () => {
    const { run, calls } = fakeRun(async () => ({ status: 'completed' }))
    const start = createRemoteRunBinding({ run })
    await expect(start({ runId: 'l', routing: { cwd: '/w', providerId: 'claude', prompt: '   ' }, progress: () => {}, output: () => {} }))
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
    await start({ runId: 'l', routing: { cwd: '/w', providerId: 'claude', prompt: 'q' }, progress: () => {}, output: () => {} })
    expect((thrown as Error).message).toBe('remote_interactive_input_unsupported')
  })

  it('streams real trace content to the output sink (text/reasoning/tool/tool_result), separate from lifecycle', async () => {
    const { run } = fakeRun(async (req) => {
      req.emit(textEvent('Hello from the agent'))
      req.emit(thinkingEvent('let me think'))
      req.emit(toolUse('Edit', '/w/file.ts'))
      req.emit(toolResult('edit applied'))
      req.emit(controls()); req.emit(result(false)); return { status: 'completed' }
    })
    const progress = vi.fn()
    const output = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-4' })
    await start({ runId: 'l', routing: { cwd: '/w', providerId: 'claude', prompt: 'go' }, progress, output })

    expect(output.mock.calls.map(c => c[0])).toEqual([
      { kind: 'output', text: 'Hello from the agent' },
      { kind: 'reasoning', text: 'let me think' },
      { kind: 'tool', text: 'Edit /w/file.ts' },
      { kind: 'tool_result', text: 'edit applied' }
    ])
    // Content never leaks into the opaque lifecycle markers.
    const markers = progress.mock.calls.map(c => JSON.parse(c[0] as string))
    expect(markers.some(m => JSON.stringify(m).includes('Hello from the agent'))).toBe(false)
  })
})
