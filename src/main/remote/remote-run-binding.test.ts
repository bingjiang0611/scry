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
const textEvent = (text: string): TraceEvent => ({ id: 't', ts: '2020', runId: 'x', kind: 'model', stage: 'text', text })
const thinkingEvent = (thinking: string): TraceEvent => ({ id: 'k', ts: '2020', runId: 'x', kind: 'model', stage: 'thinking', thinking })
const toolUse = (tool: string, filePath?: string): TraceEvent => ({ id: 'u', ts: '2020', runId: 'x', kind: 'tool', stage: `tool:${tool}`, tool, toolUseId: 'tu1', ...(filePath ? { filePath } : {}) })
const toolResult = (output: string): TraceEvent => ({ id: 'o', ts: '2020', runId: 'x', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu1', output })

describe('remote run binding (live seam; no Provider process is spawned)', () => {
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

  it('runs the routed provider once and reports a truthful settled lifecycle', async () => {
    const { run, calls } = fakeRun(async (req) => { req.emit(result(false)); return { status: 'completed' } })
    const progress = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-1' })
    await start({ runId: 'ledger-1', routing: { cwd: '/w', providerId: 'claude', agentProfileId: 'p', prompt: '  hi  ' }, progress, output: () => {} })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ runId: 'scry-1', prompt: 'hi', cwd: '/w', agentProfileId: 'p', attachments: [] })
    // Native defaults preserved: no silent approval-mode escalation.
    expect(calls[0].permissionMode).toBeUndefined()
    expect(calls[0].model).toBeUndefined()
    // A brand-new session does not resume anything.
    expect(calls[0].resume).toBeUndefined()

    const markers = progress.mock.calls.map(c => JSON.parse(c[0] as string))
    expect(markers[0]).toEqual({ event: 'bound', ledgerRunId: 'ledger-1', scryRunId: 'scry-1', providerId: 'claude', cwd: '/w' })
    expect(markers.filter(marker => marker.event === 'started')).toEqual([{ event: 'started' }])
    expect(markers).toContainEqual({ event: 'result', isError: false, tokensIn: 11, tokensOut: 22, costUsd: 0.5 })
    expect(markers.at(-1)).toEqual({ event: 'settled', status: 'completed' })
  })

  it('forwards native Provider questions to the authenticated interaction callback', async () => {
    const requestUserInput = vi.fn(async (request) => ({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered' as const,
      answers: { Continue: 'Allow' }
    }))
    const { run } = fakeRun(async (req) => {
      req.onExternalSessionId?.('provider-session')
      await req.requestUserInput?.({
        runId: req.runId,
        questionId: 'permission-1',
        questionKind: 'permission',
        questions: [{
          question: 'Continue', header: 'Permission', multiSelect: false,
          options: [{ label: 'Allow', description: 'Proceed' }, { label: 'Deny', description: 'Stop' }]
        }]
      }, new AbortController().signal)
      return { status: 'completed' }
    })
    const onRunArchive = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-question', onRunArchive })
    await start({
      runId: 'ledger-question',
      routing: { cwd: '/w', providerId: 'codex', prompt: 'go' },
      progress: () => {}, output: () => {}, requestUserInput
    })
    expect(requestUserInput).toHaveBeenCalledWith(expect.objectContaining({ runId: 'scry-question', questionId: 'permission-1' }), expect.any(AbortSignal))
    expect(onRunArchive.mock.calls[0]?.[0].items).toEqual([
      expect.objectContaining({ kind: 'harness', stage: 'runtime:controls', runId: 'scry-question' }),
      expect.objectContaining({
        kind: 'human', stage: 'intervention', intervention: expect.objectContaining({
          resolution: 'answered', response: expect.objectContaining({ answers: { Continue: 'Allow' } })
        })
      })
    ])
  })

  it('mirrors a pending question to the Mac observer and closes it even when the broker rejects', async () => {
    const order: string[] = []
    const question = (questionId: string) => ({
      runId: 'scry-mirror', questionId, questionKind: 'clarification' as const,
      questions: [{ question: 'Pick', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }]
    })
    const requestUserInput = vi.fn(async (request: { runId: string; questionId: string }) => {
      order.push(`broker:${request.questionId}`)
      if (request.questionId === 'q-withdrawn') throw new Error('provider_cancelled')
      return { runId: request.runId, questionId: request.questionId, behavior: 'answered' as const, answers: { Pick: 'A' } }
    })
    const { run } = fakeRun(async (req) => {
      await req.requestUserInput?.(question('q-answered'), new AbortController().signal)
      await req.requestUserInput?.(question('q-withdrawn'), new AbortController().signal).catch(() => {})
      return { status: 'completed' }
    })
    let ledgerRunId: string | undefined
    const start = createRemoteRunBinding({
      run,
      nextScryRunId: () => 'scry-mirror',
      observe: (info) => {
        ledgerRunId = info.ledgerRunId
        return {
          attach: () => {}, event: () => {}, session: () => {},
          question: (request) => order.push(`open:${request.runId}:${request.questionId}`),
          questionClosed: (questionId) => order.push(`closed:${questionId}`),
          done: () => {}, settled: () => {}
        }
      }
    })
    await start({ runId: 'ledger-mirror', routing: { cwd: '/w', providerId: 'pi', prompt: 'go' }, progress: () => {}, output: () => {}, requestUserInput })
    // The Mac answers through the ledger runId; the question it shows carries the scry runId.
    expect(ledgerRunId).toBe('ledger-mirror')
    expect(order).toEqual([
      'open:scry-mirror:q-answered', 'broker:q-answered', 'closed:q-answered',
      'open:scry-mirror:q-withdrawn', 'broker:q-withdrawn', 'closed:q-withdrawn'
    ])
  })

  it('forwards only explicitly selected model, effort and permission controls', async () => {
    const { run, calls } = fakeRun(async () => ({ status: 'completed' }))
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-controls' })
    await start({ runId: 'ledger-controls', routing: {
      cwd: '/w', providerId: 'opencode', prompt: 'go', modelId: 'gpt-5.4', modelProviderId: 'openai', effort: 'high', permissionMode: 'full_access'
    }, progress: () => {}, output: () => {} })

    expect(calls[0]).toMatchObject({
      model: { id: 'gpt-5.4', providerId: 'openai' }, effort: 'high', permissionMode: 'full_access'
    })
  })

  it('forwards real image attachments and injects UTF-8 files into Provider context without changing the catalog prompt', async () => {
    const image = { kind: 'image' as const, name: 'screen.jpg', mimeType: 'image/jpeg', dataBase64: '/9j/', size: 3 }
    const text = { kind: 'text' as const, name: 'error.log', mimeType: 'text/plain', dataBase64: Buffer.from('boom').toString('base64'), size: 4 }
    const { run, calls } = fakeRun(async (req) => {
      req.onExternalSessionId?.('ext-files')
      req.emit(result(false))
      return { status: 'completed' }
    })
    const onRunStarted = vi.fn()
    const onRunArchive = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-files', onRunStarted, onRunArchive })
    await start({ runId: 'ledger-files', routing: { cwd: '/w', providerId: 'qoder', prompt: 'inspect', attachments: [image, text] }, progress: () => {}, output: () => {} })

    expect(calls[0].prompt).toContain('inspect')
    expect(calls[0].prompt).toContain('<scry_attached_file name="error.log" mime="text/plain">\nboom')
    expect(calls[0].attachments).toEqual([image])
    expect(onRunStarted).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'inspect' }))
    expect(onRunArchive).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'inspect', attachments: [image] }))
  })

  it('resumes and archives the SAME provider session even when the Provider does not re-emit its session id', async () => {
    // Qoder resumes successfully but does not call onExternalSessionId again.
    // routing.resume must therefore be the catalog/archive identity.
    const { run, calls } = fakeRun(async (req) => { req.emit(textEvent('continued')); req.emit(result(false)); return { status: 'completed' } })
    const onRunStarted = vi.fn()
    const onRunSession = vi.fn()
    const onRunArchive = vi.fn()
    const progress = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-r', onRunStarted, onRunSession, onRunArchive })
    await start({ runId: 'ledger-r', routing: { cwd: '/w', providerId: 'qoder', prompt: 'more', resume: ' ext-existing ' }, progress, output: () => {} })

    expect(calls[0]).toMatchObject({ prompt: 'more', cwd: '/w', resume: 'ext-existing' })
    // Never create an unopenable pending catalog row for a resumed conversation.
    expect(onRunStarted).not.toHaveBeenCalled()
    expect(onRunSession).toHaveBeenCalledWith({ providerId: 'qoder', cwd: '/w', prompt: 'more', scryRunId: 'scry-r', externalSessionId: 'ext-existing', agentProfileId: undefined })
    expect(onRunArchive).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'qoder', scryRunId: 'scry-r', externalSessionId: 'ext-existing', status: 'completed'
    }))
    expect(progress.mock.calls.map(c => JSON.parse(c[0] as string))).toContainEqual({ event: 'session', externalSessionId: 'ext-existing', resumed: true })
  })

  it('surfaces the run to the Mac catalog: onRunStarted at bind, onRunSession with the real externalSessionId', async () => {
    const { run } = fakeRun(async (req) => {
      req.onExternalSessionId?.('ext-abc')
      req.emit(result(false)); return { status: 'completed' }
    })
    const onRunStarted = vi.fn()
    const onRunSession = vi.fn()
    const onRunArchive = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-cat', onRunStarted, onRunSession, onRunArchive })
    await start({ runId: 'ledger-cat', routing: { cwd: '/w', providerId: 'qoder', agentProfileId: 'p', prompt: '  hi  ' }, progress: () => {}, output: () => {} })
    // Pending catalog entry at bind (visible on the Mac before the session id).
    expect(onRunStarted).toHaveBeenCalledWith({ providerId: 'qoder', cwd: '/w', prompt: 'hi', scryRunId: 'scry-cat', agentProfileId: 'p' })
    // Resolved to the Provider's REAL resumable session id.
    expect(onRunSession).toHaveBeenCalledWith({ providerId: 'qoder', cwd: '/w', prompt: 'hi', scryRunId: 'scry-cat', externalSessionId: 'ext-abc', agentProfileId: 'p' })
    // Durable archive on terminal: real accumulated events + status, keyed by the
    // Provider session id so the Mac can OPEN the transcript.
    expect(onRunArchive).toHaveBeenCalledTimes(1)
    const archive = onRunArchive.mock.calls[0][0]
    expect(archive).toMatchObject({ providerId: 'qoder', cwd: '/w', prompt: 'hi', scryRunId: 'scry-cat', externalSessionId: 'ext-abc', status: 'completed' })
    expect(Array.isArray(archive.items)).toBe(true)
    expect(archive.items.length).toBeGreaterThan(0)
  })

  it('does NOT archive when the run never got a Provider session id (nothing to key or resume)', async () => {
    const { run } = fakeRun(async (req) => { req.emit({ ...result(true), text: 'died' }); return { status: 'failed' } })
    const onRunArchive = vi.fn()
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-x', onRunArchive })
    await expect(start({ runId: 'l', routing: { cwd: '/w', providerId: 'claude', prompt: 'go' }, progress: () => {}, output: () => {} }))
      .rejects.toThrow('provider_run_failed')
    expect(onRunArchive).not.toHaveBeenCalled()
  })

  it('rejects (ledger markFailed) when the provider result is a failure, surfacing its message', async () => {
    const { run } = fakeRun(async (req) => {
      req.emit({ ...result(true), text: 'boom detail' }); return { status: 'failed' }
    })
    const start = createRemoteRunBinding({ run, nextScryRunId: () => 'scry-2' })
    await expect(start({ runId: 'l', routing: { cwd: '/w', providerId: 'codex', prompt: 'go' }, progress: () => {}, output: () => {} }))
      .rejects.toThrow('provider_run_failed: boom detail')
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
})
