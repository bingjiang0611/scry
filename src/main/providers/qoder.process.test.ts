import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { bindQoderTestHelpers, resetQoderTestState } from './qoder.test-support'

const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
vi.mock('node:child_process', () => ({ spawn: t.sdk.spawn }))
vi.mock('../process-diagnostics', async () => (await import('./qoder.test-support')).qoderDiagnosticsModule(t))
vi.mock('@qoder-ai/qoder-agent-sdk', async () => (await import('./qoder.test-support')).qoderSdkModule(t))
vi.mock('./qoder-daemon', async () => (await import('./qoder.test-support')).qoderDaemonModule(t))
vi.mock('../claude-locate', async () => (await import('./qoder.test-support')).qoderLocateModule(t))

import {
  createQoderAdapter,
  resolveQoderSdkExecutable
} from './qoder'

const { sdk, diagnostics, daemonFake } = t
const { useLease, untilQueried } = bindQoderTestHelpers(t)

describe('Qoder provider adapter · daemon lifecycle and process control', () => {
  beforeEach(() => resetQoderTestState(t))

  function startIdentityRun(identity: { pid: number; startedAt?: string; command?: string } | undefined) {
    const lease = useLease(identity ? { pid: identity.pid, identity } : {})
    let release = (): void => {}
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => { release = resolve })
        yield { type: 'result', subtype: 'success', session_id: 'qoder-identity-test' }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(async () => release())
    }))
    const handle = createQoderAdapter().run({
      runId: 'run-identity-test', prompt: 'work', cwd: '/repo', attachments: [], emit: () => {}
    })
    return { handle, lease, started: async () => {
      for (let attempt = 0; attempt < 20 && !sdk.query.mock.calls.length; attempt += 1) await Promise.resolve()
      expect(sdk.query).toHaveBeenCalled()
    } }
  }

  it.each([
    ['unknown', undefined],
    ['without a start time', { pid: 901 }]
  ] as const)('does not signal Qoder when its daemon identity is %s', async (_state, identity) => {
    const { handle, lease, started } = startIdentityRun(identity)
    await started()

    handle.interrupt()
    handle.forceKill()
    await Promise.resolve()
    await Promise.resolve()

    expect(diagnostics.signal).not.toHaveBeenCalled()
    // The daemon is still stopped through the SDK handle that owns it.
    expect(lease.stop).toHaveBeenCalled()
    await handle.promise
  })

  it('force-kills only the identity-checked tree of this run\'s daemon', async () => {
    const identity = { pid: 901, startedAt: 'Wed Oct 15 10:00:00 2026', command: 'qoder --sdk' }
    const { handle, lease, started } = startIdentityRun(identity)
    await started()

    handle.forceKill()
    await Promise.resolve()
    await Promise.resolve()

    expect(diagnostics.signal).toHaveBeenCalledWith({ identity, signal: 'SIGKILL' })
    expect(lease.stop).toHaveBeenCalled()
    handle.interrupt()
    await handle.promise
  })

  it('stops the run\'s daemon after the stream settles, before reading native evidence', async () => {
    const lease = useLease({ pid: 902 })
    const order: string[] = []
    lease.stop.mockImplementation(async () => { order.push('stop') })
    sdk.getSessionMessages.mockImplementation(async () => { order.push('transcript'); return [] })
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', session_id: 'qoder-stop-order' }
      },
      close: vi.fn(async () => { order.push('close') }),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    await createQoderAdapter().run({ runId: 'run-stop-order', prompt: 'work', cwd: '/repo', attachments: [], emit: () => {} }).promise
    expect(order.slice(0, 2)).toEqual(['close', 'stop'])
    expect(order).toContain('transcript')
  })

  it('resolves the qodercli symlink to its JavaScript bundle for the SDK launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-qoder-cli-'))
    try {
      const script = join(root, 'qodercli.js')
      const bin = join(root, 'qodercli')
      await writeFile(script, '#!/usr/bin/env node\n')
      await symlink(script, bin)
      expect(resolveQoderSdkExecutable(bin)).toBe(await realpath(script))
      expect(resolveQoderSdkExecutable(join(root, 'missing'))).toBe(join(root, 'missing'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a run when the Qoder child exits but the SDK stream never settles', async () => {
    vi.useFakeTimers()
    try {
      const child = useLease({ pid: 123 })
      const close = vi.fn().mockResolvedValue(undefined)
      sdk.query.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise(() => {})
          },
          close,
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })

      const run = createQoderAdapter().run({
        runId: 'run-exit',
        prompt: 'work',
        cwd: '/repo',
        attachments: [],
        emit: vi.fn()
      })
      const rejected = expect(run.promise).rejects.toThrow('Qoder 守护进程已失效，但 SDK 事件流未结束')
      for (let attempt = 0; attempt < 20 && !sdk.query.mock.calls.length; attempt += 1) await Promise.resolve()
      child.emit('exit', 143, null)
      await vi.advanceTimersByTimeAsync(0)

      await rejected
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a structured Qoder failure when the CLI exits with code 1 afterwards', async () => {
    const child = useLease({ pid: 124 })
    const close = vi.fn().mockRejectedValue(new Error('Qoder CLI process exited with code 1'))
    sdk.query.mockImplementation(() => {
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['Unknown slash command: /rate-workflow']
          }
          child.emit('exit', 1, null)
          throw new Error('Qoder CLI process exited with code 1')
        },
        close,
        interrupt: vi.fn().mockResolvedValue(undefined)
      }
    })

    const events: TraceEvent[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-provider-failure',
      prompt: '/rate-workflow',
      cwd: '/repo',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(result.stopped).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness',
      stage: 'result',
      text: 'Unknown slash command: /rate-workflow',
      isError: true
    }))
  })

  it('settles a stop during the daemon start at once and stops the daemon that arrives later', async () => {
    let arrive!: (lease: unknown) => void
    daemonFake.next = new Promise((resolve) => { arrive = resolve }) as never
    const handle = createQoderAdapter().run({ runId: 'run-early-stop', prompt: 'work', cwd: '/repo', attachments: [], emit: () => {} })
    await Promise.resolve()
    handle.interrupt()
    await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
    expect(sdk.query).not.toHaveBeenCalled()
    const stop = vi.fn().mockResolvedValue(undefined)
    arrive({ daemon: {}, stderrTail: () => '', onFailure: () => () => {}, stop })
    for (let attempt = 0; attempt < 10 && !stop.mock.calls.length; attempt += 1) await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('names a new session itself and adopts that id from the first Provider frame without one', async () => {
    useLease({ pid: 903 })
    let release = (): void => {}
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        // Hooks can arrive before any frame names the session; an empty id is no id.
        yield { type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart', hook_event: 'SessionStart', session_id: '' }
        await new Promise<void>((resolve) => { release = resolve })
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn(async () => release())
    }))
    const seen: string[] = []
    const handle = createQoderAdapter().run({
      runId: 'run-preset-session', prompt: 'work', cwd: '/repo', attachments: [], emit: () => {},
      onExternalSessionId: (id) => seen.push(id)
    })
    await untilQueried()
    const requested = sdk.query.mock.calls[0][0].options.sessionId as string
    expect(requested).toMatch(/^[0-9a-f-]{36}$/)
    for (let attempt = 0; attempt < 20 && !seen.length; attempt += 1) await Promise.resolve()
    expect(seen).toEqual([requested])
    expect(handle.getExternalSessionId?.()).toBe(requested)
    handle.interrupt()
    await expect(handle.promise).resolves.toMatchObject({ externalSessionId: requested, stopped: true })
  })

  it('does not name a resumed session, and follows an id the Provider reports', async () => {
    useLease({ pid: 904 })
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', session_id: 'qoder-resumed' }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    const result = await createQoderAdapter().run({
      runId: 'run-resume-session', prompt: 'work', cwd: '/repo', attachments: [], resume: 'qoder-resumed', emit: () => {}
    }).promise
    expect(sdk.query.mock.calls[0][0].options).not.toHaveProperty('sessionId')
    expect(result.externalSessionId).toBe('qoder-resumed')
  })
})
