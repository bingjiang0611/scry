import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createPiAdapter } from './pi'
import { withFixture, withRotomFixture } from './pi-test-fixture'
import * as shellEnvironment from '../claude-locate'
import type { TraceEvent } from '../../shared/trace'

describe('Pi RPC Provider', () => {
  it('reuses a settled Rotom RPC across turns and invalidates it with the session context', async () => {
    await withRotomFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const request = (runId: string, prompt: string, resume?: string) => adapter.run({
        runId, prompt, cwd, resume, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise
      try {
        const first = await request('run-rotom-first', 'first')
        await expect(request('run-rotom-second', 'second', first.externalSessionId)).resolves.toMatchObject({
          externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-2', status: 'completed'
        })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(1)

        await adapter.invalidateContext?.({
          providerId: 'pi', agentProfileId: profile.id, cwd, externalSessionId: first.externalSessionId
        })
        await expect(request('run-rotom-third', 'third', first.externalSessionId)).resolves.toMatchObject({
          externalSessionId: 'pi-session-1', status: 'completed'
        })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(2)
      } finally {
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it.each([undefined, '登录 shell 环境采集失败：超时（15s）；修复后重新发送将重试采集'])('preserves transport/context evidence and launch-time shell failure: %s', async (envError) => {
    await withRotomFixture(async (profile, cwd) => {
      const envErrorSpy = vi.spyOn(shellEnvironment, 'shellEnvError').mockReturnValue(envError)
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const request = (runId: string, prompt: string, resume?: string) => adapter.run({
        runId, prompt, cwd, resume, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => {
          events.push(event)
          if (event.runId === 'run-rotom-fetch-failure' && event.stage === 'runtime:init') {
            // Another session may retry shell capture while this process is running.
            envErrorSpy.mockReturnValue(envError ? undefined : 'later unrelated shell failure')
          }
        }
      }).promise
      try {
        const first = await request('run-rotom-before-failure', 'first')
        await expect(request('run-rotom-fetch-failure', 'provider-fetch-failed', first.externalSessionId)).rejects.toMatchObject({
          message: 'fetch failed (WebSocket error)',
          brief: expect.objectContaining({ nextAction: envError ?? expect.stringContaining('WebSocket 与 SSE') })
        })
        expect(events.find((event) => event.runId === 'run-rotom-fetch-failure' && event.stage === 'result')).toMatchObject({
          isError: true,
          text: 'fetch failed (WebSocket error)',
          contextTokens: undefined,
          runtimeMetadata: expect.objectContaining({ transportError: 'WebSocket error', shellEnvError: envError ?? null })
        })
        await expect(request('run-rotom-after-failure', 'after', first.externalSessionId)).resolves.toMatchObject({
          externalSessionId: 'pi-session-1', status: 'completed'
        })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(1)
      } finally {
        envErrorSpy.mockRestore()
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it('starts a fresh Rotom RPC when the launch environment changes, but keeps the session', async () => {
    await withRotomFixture(async (profile, cwd) => {
      const base = { ...process.env } as Record<string, string>
      const envSpy = vi.spyOn(shellEnvironment, 'shellEnv').mockReturnValue(base)
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const request = (runId: string, resume?: string) => adapter.run({
        runId, prompt: 'first', cwd, resume, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise
      try {
        const first = await request('before-env-recovery')
        envSpy.mockReturnValue({ ...base, HTTPS_PROXY: 'http://127.0.0.1:12345' })
        await expect(request('after-env-recovery', first.externalSessionId)).resolves.toMatchObject({
          externalSessionId: first.externalSessionId, status: 'completed'
        })
        const starts = readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')
        expect(starts).toHaveLength(2)
        expect(() => process.kill(Number(starts[0]), 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        await request('same-env', first.externalSessionId)
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(2)
      } finally {
        envSpy.mockRestore()
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it('starts a fresh Rotom RPC after the active transport process exits', async () => {
    await withRotomFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      try {
        await expect(adapter.run({
          runId: 'run-rotom-exit', prompt: 'transport-exit', cwd, resume: 'pi-session-1', agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: vi.fn()
        }).promise).rejects.toThrow()
        await expect(adapter.run({
          runId: 'run-rotom-recovered', prompt: 'recovered', cwd, resume: 'pi-session-1', agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: vi.fn()
        }).promise).resolves.toMatchObject({ status: 'completed' })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(2)
      } finally {
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it('accepts valid JSONL events larger than 16 MiB without terminating the Pi run', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-large-event', prompt: 'large-event', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-1', status: 'completed'
      })
    })
  }, 30_000)

  it('settles through oversized lifecycle and entry snapshots without losing live evidence', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({
        listProfiles: async () => [profile], resolveProfile: async () => profile, rpcMaxFrameBytes: 1024 * 1024
      })
      const handle = adapter.run({
        runId: 'run-large-snapshots', prompt: 'large-snapshots', cwd, agentProfileId: profile.id,
        permissionMode: 'full_access', attachments: [], emit: (event) => events.push(event)
      })
      expect((await handle.promise).status).toBe('completed')
      expect(handle.getProviderTurnId?.()).toBe('pi-user-1')
      expect(events.find((event) => event.stage === 'tool_result' && event.toolUseId === 'tool-read')?.output).toBe('contents')
      expect(events.filter((event) => event.stage === 'result')).toEqual([
        expect.objectContaining({ isError: false, tokensIn: 10, tokensOut: 4 })
      ])
    })
  })

  it('terminates an unframed JSONL message after the explicit 64 MiB residency boundary', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({
        listProfiles: async () => [profile],
        resolveProfile: async () => profile,
        rpcMaxFrameBytes: 1024 * 1024
      })
      const handle = adapter.run({
        runId: 'run-oversized-unframed', prompt: 'oversized-unframed', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })

      await expect(handle.promise).rejects.toThrow('未完成 JSONL 消息超过 64 MiB')
    })
  }, 30_000)

})
