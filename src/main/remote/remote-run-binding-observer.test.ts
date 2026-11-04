import { describe, expect, it, vi } from 'vitest'
import { createRemoteRunBinding } from './remote-run-binding'
import type { ProviderRunHandle, ProviderRunRequest } from '../providers/types'
import type { TraceEvent } from '../../shared/trace'

const textEvent = (text: string): TraceEvent => ({ id: 't', ts: '2020', runId: 'x', kind: 'model', stage: 'text', text })
const thinkingEvent = (thinking: string): TraceEvent => ({ id: 'k', ts: '2020', runId: 'x', kind: 'model', stage: 'thinking', thinking })
const toolUse = (tool: string, filePath?: string): TraceEvent => ({ id: 'u', ts: '2020', runId: 'x', kind: 'tool', stage: `tool:${tool}`, tool, toolUseId: 'tu1', ...(filePath ? { filePath } : {}) })
const toolResult = (output: string): TraceEvent => ({ id: 'o', ts: '2020', runId: 'x', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu1', output })

const result = (isError: boolean): TraceEvent => ({
  id: 'r', ts: '2020', runId: 'x', kind: 'harness', stage: 'result', isError,
  tokensIn: 11, tokensOut: 22, costUsd: 0.5
})
function fakeRun(script: (req: ProviderRunRequest) => Promise<{ status?: 'completed' | 'failed' | 'cancelled' | 'interrupted' }>) {
  const calls: ProviderRunRequest[] = []
  const run = (_providerId: string, request: ProviderRunRequest): ProviderRunHandle => {
    calls.push(request)
    return { promise: script(request).then(r => ({ ...r })), interrupt: () => {}, forceKill: () => {}, forceKillScope: 'run_scoped', getExternalSessionId: () => undefined }
  }
  return { run, calls }
}

describe('remote run binding observer and archive lifecycle', () => {
  it('exposes the live run to a Mac observer before the archive, and settles only after it', async () => {
    const order: string[] = []
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve })
    const { run } = fakeRun(async (req) => {
      req.emit(textEvent('working'))
      req.onExternalSessionId?.('pi-session-1')
      await providerGate
      return { status: 'completed' }
    })
    let releaseArchive!: () => void
    const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve })
    const observed: TraceEvent[] = []
    const start = createRemoteRunBinding({
      run,
      nextScryRunId: () => 'scry-observed',
      observe: (info) => {
        order.push(`observe:${info.scryRunId}`)
        return {
          attach: () => order.push('attach'),
          event: (ev) => observed.push(ev),
          session: (id) => order.push(`session:${id}`),
          question: () => {},
          questionClosed: () => {},
          done: ({ status }) => order.push(`done:${status}`),
          settled: () => order.push('settled')
        }
      },
      onRunArchive: async () => { order.push('archive:start'); await archiveGate; order.push('archive:end') }
    })
    const finished = start({ runId: 'l', routing: { cwd: '/w', providerId: 'pi', prompt: 'go' }, progress: () => {}, output: () => {} })
    await vi.waitFor(() => expect(order).toContain('attach'))
    // Live, not archived: the event is already observable while the Provider runs.
    expect(observed).toEqual([
      expect.objectContaining({ kind: 'harness', stage: 'runtime:controls', runId: 'scry-observed' }),
      expect.objectContaining({ kind: 'model', stage: 'text', text: 'working' })
    ])
    expect(order).toEqual(['observe:scry-observed', 'session:pi-session-1', 'attach'])
    releaseProvider()
    await vi.waitFor(() => expect(order).toContain('archive:start'))
    expect(order).not.toContain('settled')
    releaseArchive()
    await finished
    expect(order.slice(3)).toEqual(['done:completed', 'archive:start', 'archive:end', 'settled'])
  })

  it('preserves native turn IDs so continuation archives can replace the matching native record', async () => {
    const { run } = fakeRun(async (request) => {
      request.onExternalSessionId?.('phone-session')
      return { status: 'completed', providerTurnId: 'native-user', forkTurnId: 'native-leaf' }
    })
    const onRunArchive = vi.fn()
    const start = createRemoteRunBinding({ run, onRunArchive })
    await start({ runId: 'ledger', routing: { providerId: 'pi', cwd: '/w', prompt: 'phone prompt' },
      progress: () => {}, output: () => {} })
    expect(onRunArchive).toHaveBeenCalledWith(expect.objectContaining({
      providerTurnId: 'native-user', forkTurnId: 'native-leaf'
    }))
  })

  it('archives partial events and the real error when the Provider promise rejects', async () => {
    const { run } = fakeRun(async (request) => {
      request.onExternalSessionId?.('phone-session')
      request.emit(textEvent('already visible on phone'))
      throw new Error('transport disconnected')
    })
    const onRunArchive = vi.fn()
    const start = createRemoteRunBinding({ run, onRunArchive })
    await expect(start({ runId: 'ledger', routing: { providerId: 'pi', cwd: '/w', prompt: 'phone prompt' },
      progress: () => {}, output: () => {} })).rejects.toThrow('transport disconnected')
    expect(onRunArchive).toHaveBeenCalledOnce()
    expect(onRunArchive).toHaveBeenCalledWith(expect.objectContaining({
      externalSessionId: 'phone-session', status: 'failed', error: 'transport disconnected',
      items: expect.arrayContaining([expect.objectContaining({ text: 'already visible on phone' })])
    }))
  })

  it('coalesces live checkpoints and drains an in-flight write before terminal archive', async () => {
    vi.useFakeTimers()
    try {
      let request!: ProviderRunRequest
      let finish!: () => void
      const gate = new Promise<void>((resolve) => { finish = resolve })
      const { run } = fakeRun(async (value) => {
        request = value
        request.onExternalSessionId?.('phone-session')
        request.emit(textEvent('first'))
        await gate
        return { status: 'completed' }
      })
      let release!: () => void
      const diskGate = new Promise<void>((resolve) => { release = resolve })
      const onRunCheckpoint = vi.fn(async () => { await diskGate })
      const onRunArchive = vi.fn()
      const start = createRemoteRunBinding({ run, onRunCheckpoint, onRunArchive })
      const pending = start({ runId: 'ledger', routing: { providerId: 'pi', cwd: '/w', prompt: 'phone prompt' },
        progress: () => {}, output: () => {} })
      await vi.advanceTimersByTimeAsync(1000)
      expect(onRunCheckpoint).toHaveBeenCalledOnce()
      request.emit(textEvent('second'))
      await vi.advanceTimersByTimeAsync(5000)
      expect(onRunCheckpoint).toHaveBeenCalledOnce()
      // The captured snapshot is immutable while the Provider keeps emitting.
      expect(onRunCheckpoint.mock.calls[0]).toEqual([expect.objectContaining({
        items: expect.not.arrayContaining([expect.objectContaining({ text: 'second' })])
      })])
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect(onRunArchive).not.toHaveBeenCalled()
      release()
      await pending
      expect(onRunArchive).toHaveBeenCalledWith(expect.objectContaining({
        status: 'completed', items: expect.arrayContaining([expect.objectContaining({ text: 'second' })])
      }))
      await vi.advanceTimersByTimeAsync(5000)
      expect(onRunCheckpoint).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('settles the observer even when the Provider cannot start', async () => {
    const settled = vi.fn()
    const done = vi.fn()
    const start = createRemoteRunBinding({
      run: () => { throw new Error('spawn failed') },
      nextScryRunId: () => 'scry-dead',
      observe: () => ({ attach: () => {}, event: () => {}, session: () => {}, question: () => {}, questionClosed: () => {}, done, settled })
    })
    await expect(start({ runId: 'l', routing: { cwd: '/w', providerId: 'pi', prompt: 'go' }, progress: () => {}, output: () => {} }))
      .rejects.toThrow('spawn failed')
    // A rejected launch now reports its real failure before settlement, rather
    // than making the observer guess that every rejection was a startup failure.
    expect(done).toHaveBeenCalledWith({ status: 'failed', errorText: 'spawn failed' })
    expect(settled).toHaveBeenCalledTimes(1)
  })
  it('forwards a device stop to the Provider interrupt and settles from the real result', async () => {
    let interrupted = 0
    let finish: ((value: { status: 'interrupted' }) => void) | undefined
    const run = (_providerId: string, _request: ProviderRunRequest): ProviderRunHandle => ({
      promise: new Promise((resolve) => { finish = resolve }),
      interrupt: () => { interrupted++; finish?.({ status: 'interrupted' }) },
      forceKill: () => {}, forceKillScope: 'run_scoped', getExternalSessionId: () => undefined
    })
    const progress: string[] = []
    const stop = new AbortController()
    const pending = createRemoteRunBinding({ run })({
      runId: 'ledger-run', routing: { cwd: '/p', providerId: 'claude', prompt: 'go' },
      progress: (detail) => { if (detail) progress.push(detail) }, output: () => {}, stopSignal: stop.signal
    })
    expect(interrupted).toBe(0)
    stop.abort()
    await pending
    expect(interrupted).toBe(1)
    expect(JSON.parse(progress.at(-1)!)).toEqual({ event: 'settled', status: 'interrupted' })
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
      req.emit(result(false)); return { status: 'completed' }
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

  it('keeps authoritative replacements correct on the append-only output seam', async () => {
    const { run } = fakeRun(async (req) => {
      req.emit({
        id: 'delta', ts: '2020', runId: 'x', kind: 'model', stage: 'text_delta', text: 'hel', messageId: 'assistant-1'
      })
      req.emit({
        id: 'prefix', ts: '2020', runId: 'x', kind: 'model', stage: 'text', text: 'hello', messageId: 'assistant-1',
        runtimeMetadata: { replacesStreamedText: true }
      })
      req.emit({
        id: 'identical', ts: '2020', runId: 'x', kind: 'model', stage: 'text', text: 'hello', messageId: 'assistant-1',
        runtimeMetadata: { replacesStreamedText: true }
      })
      req.emit({
        id: 'canonical', ts: '2020', runId: 'x', kind: 'model', stage: 'text', text: 'canonical', messageId: 'assistant-1',
        runtimeMetadata: { replacesStreamedText: true }
      })
      req.emit(result(false)); return { status: 'completed' }
    })
    const output = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-replacement' })
    await start({ runId: 'ledger-replacement', routing: { cwd: '/w', providerId: 'opencode', prompt: 'go' }, progress: () => {}, output })

    expect(output.mock.calls.map(c => c[0])).toEqual([
      { kind: 'output', text: 'hel' },
      { kind: 'output', text: 'lo' },
      { kind: 'output', text: 'canonical' }
    ])
  })

  // The Mac and the phone's history read this observation while the first turn
  // is still running (it has no archive yet). Before this hook existed a
  // device-started run was invisible to both until it ended.
})
