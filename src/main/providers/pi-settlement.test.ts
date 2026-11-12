import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createPiAdapter } from './pi'
import { withFixture } from './pi-test-fixture'
import type { TraceEvent } from '../../shared/trace'

describe('Pi RPC Provider', () => {
  it('does not truncate native Pi tool results before canonical persistence', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-large-tool', prompt: 'large-tool', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })
      await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
      const output = events.find((event) => event.toolUseId === 'tool-read' && event.stage === 'tool_result')?.output
      expect(typeof output).toBe('string')
      expect((output as string).length).toBeGreaterThan(200_000)
      expect(output).toContain('PI-TOOL-END')
      expect(output).not.toContain('truncated by Scry')
    })
  }, 15_000)

  it('keeps slow native startup owned beyond 60 seconds and remains explicitly stoppable', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'hold-startup'), '')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let received!: () => void
      const startupObserved = new Promise<void>((resolve) => { received = resolve })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-startup-wait', prompt: 'must not execute', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn(),
        requestUserInput: async (question, signal) => {
          received()
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          return { runId: question.runId, questionId: question.questionId, behavior: 'cancelled' }
        }
      })
      const terminal = vi.fn()
      void handle.promise.then(terminal, terminal)
      try {
        await startupObserved
        await vi.advanceTimersByTimeAsync(61_000)
        expect(terminal).not.toHaveBeenCalled()
        vi.useRealTimers()
        handle.forceKill?.()
        await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
        expect(handle.getProviderTurnId?.()).toBeUndefined()
      } finally {
        vi.useRealTimers()
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
      }
    })
  }, 15_000)

  it.each(['late-prompt-ack', 'late-entry'])('keeps %s owned across 31 minutes of silence', async (prompt) => {
    await withFixture(async (profile, cwd) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let release!: () => void
      let received!: () => void
      const questionReceived = new Promise<void>((resolve) => { received = resolve })
      const answer = new Promise<void>((resolve) => { release = resolve })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-delayed', prompt, cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn(),
        requestUserInput: async (question) => {
          received()
          await answer
          return { runId: question.runId, questionId: question.questionId, behavior: 'answered', answers: { 'Release?': 'Continue' } }
        }
      })
      const terminal = vi.fn()
      void handle.promise.then(terminal, terminal)
      try {
        await questionReceived
        await vi.advanceTimersByTimeAsync(31 * 60_000)
        expect(terminal).not.toHaveBeenCalled()
        vi.useRealTimers()
        release()
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed', providerTurnId: 'pi-user-1' })
      } finally {
        vi.useRealTimers()
        release()
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
      }
    })
  }, 15_000)

  it('does not turn a settled native run into failure when final metadata times out', async () => {
    await withFixture(async (profile, cwd) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const events: TraceEvent[] = []
      let observed!: () => void
      const finalStateRequested = new Promise<void>((resolve) => { observed = resolve })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-final-state', prompt: 'final-state-hang', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event),
        requestUserInput: async (question) => {
          observed()
          return { runId: question.runId, questionId: question.questionId, behavior: 'answered', answers: { 'Final state': 'Continue' } }
        }
      })
      try {
        await finalStateRequested
        await vi.advanceTimersByTimeAsync(16_000)
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed', providerTurnId: 'pi-user-1' })
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'harness', stage: 'runtime:telemetry_degraded',
          runtimeMetadata: expect.objectContaining({ capability: 'final_state' })
        }))
      } finally {
        vi.useRealTimers()
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
      }
    })
  }, 15_000)

  it('does not impose a settlement duration deadline', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const startedAt = Date.now()
      const handle = adapter.run({
        runId: 'run-long-active', prompt: 'long-active', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-1', status: 'completed'
      })
      expect(Date.now() - startedAt).toBeGreaterThan(70)
    })
  }, 15_000)

  it('reports an upstream aborted settlement as a failure instead of a completed turn', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-provider-aborted', prompt: 'provider-aborted', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })

      await expect(handle.promise).rejects.toMatchObject({
        message: 'Qoder: aborted',
        brief: expect.objectContaining({ stage: 'runtime' })
      })
      expect(handle.getExternalSessionId()).toBe('pi-session-1')
      expect(handle.getProviderTurnId?.()).toBe('pi-user-1')
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness',
          stage: 'result',
          isError: true,
          text: 'Qoder: aborted',
          providerStopReason: 'aborted'
        })
      ]))
    })
  }, 15_000)

  it.each(['paused', 'resume', 'approved'])('preserves explicit tool termination without reporting a Provider failure: %s', async (scenario) => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-tool-boundary', prompt: `tool-boundary:${scenario}`, cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })
      await expect(handle.promise).resolves.toMatchObject({ status: 'completed', stopped: false })
      const result = events.find((event) => event.stage === 'result')
      expect(result).toMatchObject({
        isError: false, providerStopReason: 'toolUse',
        toolTermination: { tool: 'goal_complete', message: expect.stringMatching(
          scenario === 'approved' ? /Goal complete:/ : /completion remains unverified/i
        ) }
      })
      expect(result?.text).not.toBe('toolUse')
    })
  })

  it.each(['no-terminate', 'missing-result', 'unrelated', 'later-toolUse'])('does not promote unproven toolUse settlement to success: %s', async (scenario) => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-unproven-boundary', prompt: `tool-boundary:${scenario}`, cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })
      await expect(handle.promise).rejects.toMatchObject({
        message: expect.stringContaining('工具终止证据'),
        brief: { nextAction: expect.not.stringContaining('继续当前会话重试') }
      })
      expect(events.find((event) => event.stage === 'result')).toMatchObject({ isError: true })
    })
  })

  it.each(['later-stop', 'later-error'])('does not reuse stale tool termination across assistant messages: %s', async (scenario) => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-later-message', prompt: `tool-boundary:${scenario}`, cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })
      if (scenario === 'later-stop') await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
      else await expect(handle.promise).rejects.toThrow('Qoder: request_failed')
      expect(events.find((event) => event.stage === 'result')?.toolTermination).toBeUndefined()
    })
  })

  it('asks for a new session instead of retrying a Qoder account binding failure', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-account-changed', prompt: 'provider-account-changed', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: event => events.push(event)
      })
      await expect(handle.promise).rejects.toMatchObject({
        message: 'Qoder: account_changed_start_new_session',
        brief: { nextAction: expect.stringContaining('请新建会话') }
      })
      expect(events.find(event => event.stage === 'result')).toMatchObject({
        isError: true, providerStopReason: 'error', text: 'Qoder: account_changed_start_new_session'
      })
    })
  })

  it('classifies Qoder 413 and points to the failed-turn recovery branch', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-provider-http-413', prompt: 'provider-http-413', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })

      await expect(handle.promise).rejects.toMatchObject({
        message: 'Qoder: http_413',
        brief: expect.objectContaining({ nextAction: expect.stringContaining('从失败处恢复') })
      })
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness', stage: 'result', isError: true,
          terminationReason: 'input_context_overflow'
        })
      ]))
    })
  }, 15_000)

  it.each(['fixture-pi', 'rotom'])('cold-resumes an existing native session through --session with %s', async (executableName) => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      try {
        await expect(adapter.run({
          runId: 'cold-resume', prompt: 'continue existing history', cwd, resume: 'pi-session-1',
          agentProfileId: profile.id, attachments: [], permissionMode: 'full_access', emit: vi.fn()
        }).promise).resolves.toMatchObject({ externalSessionId: 'pi-session-1', status: 'completed' })
        const argv: string[] = JSON.parse(readFileSync(join(cwd, 'fixture-argv.json'), 'utf8'))
        const sessionFlag = argv.indexOf('--session')
        expect(sessionFlag).toBeGreaterThanOrEqual(0)
        expect(argv[sessionFlag + 1]).toBe('pi-session-1')
        expect(argv.filter(arg => arg === '--session')).toHaveLength(1)
        expect(argv).not.toContain('--no-session')
      } finally {
        await adapter.dispose?.()
      }
    }, executableName)
  })

})
