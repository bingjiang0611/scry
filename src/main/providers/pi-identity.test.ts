import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPiAdapter, piContinuationKey, piRpcEnvironment } from './pi'
import { piProfileForExecutable } from '../pi-agent-profiles'
import { withFixture } from './pi-test-fixture'
import * as shellEnvironment from '../claude-locate'

describe('Pi RPC Provider', () => {
  it('rejects a resumed native session mismatch before sending the prompt', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({ runId: 'wrong-native', prompt: 'must not send', cwd, agentProfileId: profile.id,
        resume: 'different-session', trackInputReceipt: true, attachments: [], permissionMode: 'full_access', emit: vi.fn() })
      await expect(handle.promise).rejects.toThrow('交接目标与 Provider 返回的原生 session 不一致')
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'not_sent' })
      const commands = readFileSync(join(cwd, 'fixture-commands'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      expect(commands.some(command => command.type === 'prompt')).toBe(false)
    })
  }, 15_000)

  it('rejects marker-only Rotom launchers and pins both supported entry names to ROTOM_NODE', async () => {
    await withFixture(async (_profile, cwd) => {
      mkdirSync(join(cwd, 'bin'))
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@bingjiang0611/rotom', version: '0.1.25', bin: { rotom: 'bin/rotom' } }))
      for (const name of ['rotom', 'rotom-launcher']) {
        const path = join(cwd, 'bin', name)
        writeFileSync(path, '#!/bin/sh\n# runtime/launch-runtime.mjs runtime/verify-pi-runtime.mjs ROTOM_NODE ROTOM_PI\nexit 1\n')
        chmodSync(path, 0o755)
        const profile = piProfileForExecutable(path)
        const env = await piRpcEnvironment(profile, { HOME: cwd, PATH: dirname(process.execPath),
          ROTOM_NODE: process.execPath, PI_AGENT_NODE: '/not-the-rotom-node', HTTPS_PROXY: 'http://127.0.0.1:1' })
        expect(env.ROTOM_NODE).toBe(process.execPath)
        expect(env.NODE_USE_ENV_PROXY).toBe('1')
        await expect(piContinuationKey(profile, cwd, env)).rejects.toThrow(name === 'rotom' ? 'public entry contract 未验证' : 'product launcher contract 未验证')
      }
      expect(existsSync(join(cwd, 'fixture-starts'))).toBe(false)
    })
  })

  it('changes identity when synthetic auth or transport state changes and rejects a stale key', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', bin: { pi: 'fixture-pi' } }))
      mkdirSync(join(cwd, '.pi', 'agent'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'agent', 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'synthetic-auth-a' } }))
      const env = { HOME: cwd, PATH: dirname(process.execPath), PI_AGENT_NODE: process.execPath }
      const first = await piContinuationKey(profile, cwd, env)
      writeFileSync(join(cwd, '.pi', 'agent', 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'synthetic-auth-b' } }))
      const second = await piContinuationKey(profile, cwd, { ...env, HTTPS_PROXY: 'http://127.0.0.1:1' })
      expect(second).not.toBe(first)
      const current = await piContinuationKey(profile, cwd, env)
      expect(current).not.toBe(first)
      const shell = vi.spyOn(shellEnvironment, 'shellEnv').mockReturnValue(env)
      try {
        const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
        const handle = adapter.run({
          runId: 'run-pi-stale-key', prompt: 'hello', cwd, agentProfileId: profile.id,
          expectedContinuationKey: first, attachments: [], permissionMode: 'full_access', emit: vi.fn()
        })
        await expect(handle.promise).rejects.toThrow('接续身份已变化')
        expect(handle.getInputReceipt?.()).toMatchObject({ status: 'not_sent' })
      } finally { shell.mockRestore() }
    })
  }, 15_000)

  it('includes custom auth environment and project config, and rejects dynamic helpers', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', bin: { pi: 'fixture-pi' } }))
      mkdirSync(join(cwd, '.pi', 'agent'), { recursive: true })
      const auth = join(cwd, '.pi', 'agent', 'auth.json')
      writeFileSync(auth, JSON.stringify({ custom: { type: 'api_key', key: '$CUSTOM_AUTH' } }))
      const env = { HOME: cwd, PATH: dirname(process.execPath), PI_AGENT_NODE: process.execPath, CUSTOM_AUTH: 'synthetic-a' }
      const first = await piContinuationKey(profile, cwd, env)
      expect(await piContinuationKey(profile, cwd, { ...env, CUSTOM_AUTH: 'synthetic-b' })).not.toBe(first)
      writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'custom' }))
      expect(await piContinuationKey(profile, cwd, env)).not.toBe(first)
      // The helper's resolved value is the identity, so it equals the same credential written literally.
      writeFileSync(auth, JSON.stringify({ custom: { type: 'api_key', key: 'synthetic-a' } }))
      const literal = await piContinuationKey(profile, cwd, env)
      writeFileSync(auth, JSON.stringify({ custom: { type: 'api_key', key: '!printf synthetic-a' } }))
      expect(await piContinuationKey(profile, cwd, env)).toBe(literal)
      writeFileSync(auth, JSON.stringify({ custom: { type: 'api_key', key: '!printf synthetic-b' } }))
      expect(await piContinuationKey(profile, cwd, env)).not.toBe(literal)
      // models.json helpers are resolved too: a rotated model key changes the identity.
      const models = join(cwd, '.pi', 'agent', 'models.json')
      writeFileSync(models, JSON.stringify({ providers: { switch: { apiKey: '!printf model-key-a' } } }))
      const pinned = await piContinuationKey(profile, cwd, env)
      writeFileSync(models, JSON.stringify({ providers: { switch: { apiKey: '!printf model-key-b' } } }))
      expect(await piContinuationKey(profile, cwd, env)).not.toBe(pinned)
      // A helper that cannot produce a value proves nothing; the identity stays unavailable.
      writeFileSync(auth, JSON.stringify({ custom: { type: 'api_key', key: '!exit 3' } }))
      await expect(piContinuationKey(profile, cwd, env)).rejects.toThrow('动态配置 helper 未成功返回')
      writeFileSync(auth, '{broken')
      await expect(piContinuationKey(profile, cwd, env)).rejects.toThrow('JSON 无效')
    })
  }, 15_000)

  it('keeps failed Pi dispatch unknown and rejects unavailable or mismatched identity before spawn', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.continuationKey!({ providerId: 'pi', agentProfileId: profile.id, cwd })).rejects.toThrow(/身份不可用|已知/)
      const handle = adapter.run({
        runId: 'run-pi-dispatch-failed', prompt: 'preflight-reject', cwd, agentProfileId: profile.id,
        expectedContinuationKey: 'pi:expected-known-identity', trackInputReceipt: true,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })
      await expect(handle.promise).rejects.toThrow(/身份不可用|已知|变化/)
      expect(handle.getInputReceipt?.()).toMatchObject({ status: 'not_sent' })
    })
  }, 15_000)

})
