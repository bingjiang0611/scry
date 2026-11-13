import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPiAdapter } from './pi'
import { withFixture, withCommandFixture } from './pi-test-fixture'
import type { ParsedTurn } from '../normalize'

describe('Pi RPC Provider', () => {
  it('enriches archived Pi context only from the exact upstream provider and model window', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const turns = await adapter.sessionEvidence!.enrich(
        { providerId: 'pi', agentProfileId: profile.id, cwd, externalSessionId: 'pi-session-1' },
        [{
          userText: 'work',
          items: [{
            id: 'result-history', runId: 'run-history', ts: new Date().toISOString(),
            kind: 'harness', stage: 'result', contextTokens: 10, contextModel: 'test-model',
            upstreamProvider: 'openai-codex', modelUsage: [{ model: 'test-model', upstreamProvider: 'openai-codex' }]
          }]
        }]
      )

      expect(turns[0].items[0]).toMatchObject({
        contextTokens: 10,
        contextModel: 'test-model',
        contextProvider: 'openai-codex',
        contextUsageSource: 'pi_rpc_archive_usage+current_model_catalog',
        contextUsageQuality: 'inferred',
        modelUsage: [{ model: 'test-model', upstreamProvider: 'openai-codex', contextWindow: 200_000 }]
      })
    })
  }, 10_000)

  it('opens Rotom Qoder history without probing again when the archive already proves context usage', async () => {
    const resolveProfile = vi.fn(async () => undefined)
    const adapter = createPiAdapter({ listProfiles: async () => [], resolveProfile })
    const turns: ParsedTurn[] = [{
      userText: 'work',
      items: [{
        id: 'result-history', runId: 'run-history', ts: new Date().toISOString(),
        kind: 'harness', stage: 'result', contextTokens: 5_060, contextModel: 'ultimate',
        contextProvider: 'qoder', contextUsageSource: 'pi_rpc_assistant_usage', contextUsageQuality: 'exact',
        modelUsage: [{ model: 'ultimate', upstreamProvider: 'qoder', contextWindow: 272_000 }]
      }]
    }]

    await expect(adapter.sessionEvidence!.enrich(
      { providerId: 'pi', agentProfileId: 'pi:rotom', cwd: '/repo', externalSessionId: 'pi-session-1' },
      turns
    )).resolves.toBe(turns)
    expect(resolveProfile).not.toHaveBeenCalled()
  })

  it('forks Pi before the edited user entry and returns the new native session', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.forkLastTurn!.fork({
        sourceSessionId: 'pi-session-1',
        originalPrompt: 'old prompt',
        replaceRunId: 'run-last',
        replaceProviderTurnId: 'abandoned-user',
        replaceForkTurnId: 'abandoned-user',
        previousProviderTurnId: 'prompt-previous',
        previousForkTurnId: 'prompt-previous',
        agentProfileId: profile.id,
        cwd
      })).resolves.toEqual({ externalSessionId: 'pi-session-forked' })
    })
  })

  it('fences managed fork before starting Pi and again before the native mutation', async () => {
    await withCommandFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const request = { providerId: 'pi' as const, sourceSessionId: 'pi-session-1', sourceRunId: 'run-active',
        sourceProviderTurnId: 'active-user', sourceForkTurnId: 'active-user', agentProfileId: profile.id, cwd }
      await expect(adapter.forkSession!.fork({ ...request, beforeFork: async () => { throw new Error('identity changed before startup') } })).rejects.toThrow('identity changed before startup')
      expect(existsSync(join(cwd, 'fixture-starts'))).toBe(false)
      let checks = 0
      await expect(adapter.forkSession!.fork({ ...request, beforeFork: async () => {
        if (++checks === 2) throw new Error('identity changed before fork')
      } })).rejects.toThrow('identity changed before fork')
      expect(checks).toBe(2)
      const commands = readFileSync(join(cwd, 'fixture-commands'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string })
      expect(commands.some(command => command.type === 'fork' || command.type === 'clone')).toBe(false)
    })
  })

  it('clones Pi at the active leaf after the selected final turn', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.forkSession!.fork({
        providerId: 'pi',
        sourceSessionId: 'pi-session-1',
        sourceRunId: 'run-active',
        sourceProviderTurnId: 'active-user',
        sourceForkTurnId: 'active-user',
        agentProfileId: profile.id,
        cwd
      })).resolves.toEqual({ externalSessionId: 'pi-session-cloned' })
    })
  })

})
