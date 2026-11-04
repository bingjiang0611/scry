import { describe, expect, it, vi } from 'vitest'
import { createRemoteRunBinding, type RemoteRunBindingDependencies } from './remote-run-binding'
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

  it('passes only the workspace selection to the canonical host lifecycle and rejects it on the legacy executor', async () => {
    const workspace = { operationId: '11111111-1111-4111-8111-111111111111', intent: {
      kind: 'current' as const, repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64)
    } }
    const startAppRun = vi.fn(async (input: Parameters<NonNullable<RemoteRunBindingDependencies['startAppRun']>>[0]) => {
      input.onRegistered?.({ cwd: '/managed/topic' })
      return { status: 'completed' as const, recording: 'committed' as const }
    })
    const progress = vi.fn()
    await createRemoteRunBinding({ startAppRun, nextScryRunId: () => 'canonical-worktree' })({
      runId: 'ledger-worktree', routing: { cwd: '/source', providerId: 'claude', prompt: 'go', workspace },
      progress, output: vi.fn()
    })
    expect(startAppRun).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      cwd: '/source', workspace, expectedExternalSessionId: null
    }) }))
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('"cwd":"/managed/topic"'))
    const { run } = fakeRun(async () => ({ status: 'completed' }))
    await expect(createRemoteRunBinding({ run })({
      runId: 'legacy-worktree', routing: { cwd: '/source', providerId: 'claude', prompt: 'go', workspace },
      progress: vi.fn(), output: vi.fn()
    })).rejects.toThrow('remote_workspace_requires_canonical_runtime')
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
})
