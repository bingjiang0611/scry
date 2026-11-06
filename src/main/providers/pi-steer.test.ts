import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createPiAdapter, PI_RPC_COMMAND_TIMEOUT_MS } from './pi'
import { withFixture, withRotomFixture, withCommandFixture } from './pi-test-fixture'
import type { TraceEvent } from '../../shared/trace'

describe('Pi RPC Provider', () => {
  it('admits native Pi steer with images without aborting and keeps the root provider identity', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      let capability!: () => void
      const ready = new Promise<void>((resolve) => { capability = resolve })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-steer', prompt: 'steer-active', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => {
          events.push(event)
          if (event.stage === 'runtime:steer_capability') capability()
        }
      })
      await ready
      await expect(handle.steer!({
        messageId: 'steer-message', prompt: 'supplementary',
        attachments: [{ kind: 'image', name: 'diagram.png', mimeType: 'image/png', dataBase64: 'aGk=' }]
      })).resolves.toMatchObject({ status: 'accepted' })
      await expect(handle.promise).resolves.toMatchObject({ providerTurnId: 'pi-user-1', status: 'completed' })
      const steer = JSON.parse(readFileSync(join(cwd, 'fixture-steers'), 'utf8').trim())
      expect(steer).toMatchObject({ type: 'steer', message: 'supplementary', images: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] })
      const commands = readFileSync(join(cwd, 'fixture-commands'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line))
      expect(commands.some((command) => command.type === 'abort')).toBe(false)
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'harness', stage: 'runtime:steer_capability',
        steerCapability: { status: 'available', attachments: true }
      }))
    })
  }, 15_000)

  it('distinguishes native steer rejection from an admission timeout', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let ready!: () => void
      const active = new Promise<void>((resolve) => { ready = resolve })
      const rejected = adapter.run({
        runId: 'run-steer-reject', prompt: 'steer-active', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => {
          if (event.stage === 'runtime:steer_capability') ready()
        }
      })
      await active
      await expect(rejected.steer!({ messageId: 'reject', prompt: 'steer-reject', attachments: [] }))
        .resolves.toMatchObject({ status: 'rejected', message: expect.stringContaining('native steer rejected') })
      await expect(rejected.promise).resolves.toMatchObject({ status: 'completed' })
    })

    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let ready!: () => void
      const active = new Promise<void>((resolve) => { ready = resolve })
      const handle = adapter.run({
        runId: 'run-steer-timeout', prompt: 'steer-timeout', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => {
          if (event.stage === 'runtime:steer_capability') ready()
        }
      })
      await active
      vi.useFakeTimers()
      try {
        const result = handle.steer!({ messageId: 'timeout', prompt: 'steer-timeout', attachments: [] })
        await vi.advanceTimersByTimeAsync(PI_RPC_COMMAND_TIMEOUT_MS + 1)
        await expect(result).resolves.toMatchObject({ status: 'unknown', message: expect.stringContaining('admission 未知') })
      } finally {
        vi.useRealTimers()
      }
      handle.forceKill()
      await expect(handle.promise).resolves.toMatchObject({ status: 'interrupted' })
    })
  }, 20_000)

  it('quarantines steer admission when agent_end wins and refuses idle or settled steer', async () => {
    await withRotomFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let ready!: () => void
      const active = new Promise<void>((resolve) => { ready = resolve })
      const handle = adapter.run({
        runId: 'run-steer-race', prompt: 'steer-end-race', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => {
          if (event.stage === 'runtime:steer_capability') ready()
        }
      })
      await expect(handle.steer!({ messageId: 'too-early', prompt: 'idle', attachments: [] }))
        .resolves.toMatchObject({ status: 'unavailable' })
      await active
      await expect(handle.steer!({ messageId: 'race', prompt: 'steer-end-race', attachments: [] }))
        .resolves.toMatchObject({ status: 'unknown', message: expect.stringContaining('归属未知') })
      const first = await handle.promise
      expect(first).toMatchObject({ status: 'completed' })
      const next = await adapter.run({
        runId: 'run-after-steer-race', prompt: 'next', cwd, resume: first.externalSessionId,
        agentProfileId: profile.id, attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise
      expect(next).toMatchObject({ status: 'completed', providerTurnId: 'pi-user-1' })
      expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(2)
      await expect(handle.steer!({ messageId: 'settled', prompt: 'late', attachments: [] }))
        .resolves.toMatchObject({ status: 'rejected' })
      const commands = readFileSync(join(cwd, 'fixture-commands'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line))
      expect(commands.some((command) => command.type === 'abort')).toBe(false)
    })
  }, 15_000)

  it('admits a new active agent cycle without reusing a completed cycle admission guard', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let ready!: () => void
      let restarted!: () => void
      const active = new Promise<void>(resolve => { ready = resolve })
      const newCycle = new Promise<void>(resolve => { restarted = resolve })
      const handle = adapter.run({
        runId: 'steer-cycles', prompt: 'steer-active', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: event => {
          if (event.stage === 'runtime:steer_capability') ready()
          if (event.kind === 'model' && event.text === 'cycle restarted') restarted()
        }
      })
      try {
        await active
        await expect(handle.steer!({ messageId: 'old-cycle', prompt: 'steer-end-restart', attachments: [] }))
          .resolves.toMatchObject({ status: 'unknown' })
        await newCycle
        await expect(handle.steer!({ messageId: 'new-cycle', prompt: 'supplement', attachments: [] }))
          .resolves.toMatchObject({ status: 'accepted' })
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed', providerTurnId: 'pi-user-1' })
      } finally {
        handle.forceKill()
        await handle.promise.catch(() => {})
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it.each([
    { name: 'unchanged controls', model: { providerId: 'test-provider', id: 'test-model' }, effort: 'high', controls: [] },
    { name: 'unchanged effort without a model selection', model: undefined, effort: 'high', controls: [] },
    { name: 'same model with native default effort', model: { providerId: 'test-provider', id: 'test-model' }, effort: undefined, controls: ['set_model'] },
    { name: 'changed effort', model: { providerId: 'test-provider', id: 'test-model' }, effort: 'low', controls: ['set_thinking_level'] },
    { name: 'changed model', model: { providerId: 'test-provider', id: 'other-model' }, effort: 'high', controls: ['set_model', 'set_thinking_level'] },
    { name: 'changed upstream provider', model: { providerId: 'other-provider', id: 'test-model' }, effort: 'high', controls: ['set_model', 'set_thinking_level'] }
  ])('only sends necessary Pi controls before cold and reused prompts: $name', async ({ model, effort, controls }) => {
    await withCommandFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      try {
        let commandOffset = 0
        for (let turn = 0; turn < 2; turn++) {
          const events: TraceEvent[] = []
          await expect(adapter.run({
            runId: `controls-${turn}`, prompt: 'hello', cwd, agentProfileId: profile.id,
            attachments: [], permissionMode: 'full_access', model, effort,
            ...(turn ? { resume: 'pi-session-1' } : {}),
            emit: (event) => events.push(event)
          }).promise).resolves.toMatchObject({ status: 'completed', externalSessionId: 'pi-session-1' })
          const allCommands = readFileSync(join(cwd, 'fixture-commands'), 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as { type: string; provider?: string; modelId?: string; level?: string })
          const commands = allCommands.slice(commandOffset)
          commandOffset = allCommands.length
          const beforePrompt = commands.slice(0, commands.findIndex((command) => command.type === 'prompt'))
          const settings = beforePrompt.filter((command) => ['set_model', 'set_thinking_level'].includes(command.type))
          const expectedControls = turn === 0 || !effort ? controls : []
          expect(settings.map((command) => command.type)).toEqual(expectedControls)
          if (expectedControls.includes('set_model')) expect(settings[0]).toMatchObject({ provider: model!.providerId, modelId: model!.id })
          if (expectedControls.includes('set_thinking_level')) expect(settings.at(-1)).toMatchObject({ level: effort })
          expect(events.find((event) => event.stage === 'runtime:init')?.runtimeMetadata).toMatchObject({
            model: turn === 0 ? { provider: 'test-provider', id: 'test-model' }
              : { provider: model?.providerId ?? 'test-provider', id: model?.id ?? 'test-model' },
            thinkingLevel: turn === 0 ? 'high' : effort ?? 'off'
          })
          expect(events.some((event) => event.stage === 'text_delta' && event.text)).toBe(true)
        }
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(1)
      } finally {
        await adapter.dispose?.()
      }
    })
  }, 15_000)

})
