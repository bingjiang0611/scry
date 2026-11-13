import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { createPiAdapter, PI_RPC_STARTUP_TIMEOUT_MS, piRpcEnvironment, probePiAgent, questionFromExtension } from './pi'
import { piProfileForExecutable } from '../pi-agent-profiles'
import { withFixture } from './pi-test-fixture'
import * as shellEnvironment from '../claude-locate'

describe('Pi RPC Provider', () => {
  it('isolates RPC fixtures from the host HOME and pins the current Node runtime', async () => {
    await withFixture(async (profile, cwd) => {
      const env = await piRpcEnvironment(profile)
      expect(env.HOME).toBe(cwd)
      expect(env.PATH).toBe(dirname(process.execPath))
      expect(env.PI_AGENT_NODE).toBe(process.execPath)
      expect(env.ROTOM_NODE).toBe(process.execPath)
    })
  })

  it('restores structured multi-select choices from an extension text-input prompt', () => {
    const title = '[不满意点] 你最想改善什么？（可多选）\n\n1. 布局不均衡 — 卡片留白混乱\n2. 视觉风格不够精致 — 层级与质感不足'
    const request = questionFromExtension('run-input', {
      type: 'extension_ui_request',
      id: 'input-1',
      method: 'input',
      title,
      placeholder: '1,3'
    })

    expect(request?.questions[0]).toEqual({
      header: '不满意点',
      question: '你最想改善什么？',
      multiSelect: true,
      options: [
        { label: '布局不均衡', description: '卡片留白混乱', answerValue: '1' },
        { label: '视觉风格不够精致', description: '层级与质感不足', answerValue: '2' }
      ]
    })
  })

  it('keeps a plain extension input as a direct free-text question', () => {
    const request = questionFromExtension('run-input', {
      id: 'input-2',
      method: 'input',
      title: '请输入发布说明',
      placeholder: '一句话概括'
    })

    expect(request?.questions[0]).toEqual({
      header: '回答',
      question: '请输入发布说明',
      multiSelect: false,
      options: [],
      inputMode: 'singleline',
      placeholder: '一句话概括'
    })
  })

  it.each(['select', 'confirm'])('preserves the closed-choice contract for native %s dialogs', (method) => {
    const request = questionFromExtension('run-select', {
      id: 'select-1', method, title: '继续？', options: ['1. 继续', '2. 停下']
    })
    expect(request?.questions[0]).toMatchObject({ allowCustomAnswer: false, multiSelect: false })
  })

  it('cancels startup dialogs during read-only capability discovery without approving setup or sending a prompt', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'startup-ui'), '')
      const probe = await probePiAgent(profile, cwd)
      expect(probe.models).toContainEqual(expect.objectContaining({ id: 'test-model' }))
      const commands = readFileSync(join(cwd, 'fixture-commands'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(commands.filter((command) => command.type === 'extension_ui_response')).toEqual([
        { type: 'extension_ui_response', id: 'catalog-startup', cancelled: true }
      ])
      expect(commands.some((command) => command.type === 'prompt')).toBe(false)
    })
  })

  it('allows cold session startup to exceed the ordinary 15 second command deadline', () => {
    expect(PI_RPC_STARTUP_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('pins the packaged Pi runtime from supported PATH bootstrap forms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-bootstrap-'))
    try {
      const packageRoot = join(dir, 'node_modules', '@example', 'pi-coding-agent')
      const runtime = join(packageRoot, 'dist', 'cli.js')
      const launcher = join(dir, 'pi-agent')
      const bootstrap = join(dir, 'pi')
      mkdirSync(join(packageRoot, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{}')
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      chmodSync(launcher, 0o755)
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@example/pi-coding-agent',
        bin: { pi: 'dist/cli.js' }
      }), { flag: 'wx' })
      writeFileSync(runtime, '#!/usr/bin/env node\n', { flag: 'wx' })
      chmodSync(runtime, 0o755)
      writeFileSync(bootstrap, `#!/bin/sh\n: "\${PI_AGENT_PI:=${runtime}}"\nexport PI_AGENT_PI\nexec ${launcher} "$@"\n`)
      chmodSync(bootstrap, 0o755)

      const profile = piProfileForExecutable(launcher)
      expect((await piRpcEnvironment(profile, { PATH: dir, HOME: dir })).PI_AGENT_PI).toBe(realpathSync(runtime))

      writeFileSync(bootstrap, `#!/bin/sh\nPI_AGENT_PI=${runtime} \\\n\texec ${launcher} "$@"\n`)
      expect((await piRpcEnvironment(profile, { PATH: dir, HOME: dir })).PI_AGENT_PI).toBe(realpathSync(runtime))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('selects a compatible Node later on PATH for Pi launchers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-node-'))
    try {
      const oldBin = join(dir, 'old', 'bin')
      const newBin = join(dir, 'new', 'bin')
      const launcher = join(dir, 'pi-agent')
      const nativeWrapper = join(dir, 'pi')
      const rotomLauncher = join(dir, 'rotom')
      mkdirSync(oldBin, { recursive: true })
      mkdirSync(newBin, { recursive: true })
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      writeFileSync(nativeWrapper, '#!/bin/sh\nexit 0\n')
      writeFileSync(rotomLauncher, '#!/bin/sh\nexit 0\n')
      writeFileSync(join(oldBin, 'node'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify([join(oldBin, 'node'), '22.22.1'])}'\n`)
      writeFileSync(join(newBin, 'node'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify([join(newBin, 'node'), '24.18.0'])}'\n`)
      chmodSync(launcher, 0o755)
      chmodSync(nativeWrapper, 0o755)
      chmodSync(rotomLauncher, 0o755)
      chmodSync(join(oldBin, 'node'), 0o755)
      chmodSync(join(newBin, 'node'), 0o755)

      const profile = piProfileForExecutable(launcher)
      expect((await piRpcEnvironment(profile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir,
        PI_AGENT_PI: '/already/pinned/pi'
      })).PI_AGENT_NODE).toBe(realpathSync(join(newBin, 'node')))
      expect((await piRpcEnvironment(profile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir,
        PI_AGENT_NODE: join(oldBin, 'node')
      })).PI_AGENT_NODE).toBe(join(oldBin, 'node'))
      const nativeProfile = {
        id: 'pi:default',
        label: 'Pi',
        executable: nativeWrapper
      }
      await expect(piRpcEnvironment(nativeProfile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir
      })).resolves.toMatchObject({ PI_AGENT_NODE: realpathSync(join(newBin, 'node')) })

      const rotomProfile = piProfileForExecutable(rotomLauncher)
      const compatibleNode = realpathSync(join(newBin, 'node'))
      const rotomEnv = await piRpcEnvironment(rotomProfile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir
      })
      expect(rotomEnv).toMatchObject({ ROTOM_NODE: compatibleNode })
      expect(rotomEnv.PI_AGENT_NODE).toBeUndefined()
      await expect(piRpcEnvironment(rotomProfile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir,
        PI_AGENT_NODE: join(oldBin, 'node')
      })).resolves.toMatchObject({
        PI_AGENT_NODE: join(oldBin, 'node'),
        ROTOM_NODE: compatibleNode
      })
      expect((await piRpcEnvironment(rotomProfile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir,
        ROTOM_NODE: '/configured/node'
      })).ROTOM_NODE).toBe('/configured/node')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes billing-admin credentials from the Pi subprocess environment', async () => {
    const profile = { id: 'pi:test', label: 'Pi', executable: '/usr/bin/pi' }
    const env = await piRpcEnvironment(profile, {
      PATH: '/usr/bin',
      HOME: '/tmp',
      ANTHROPIC_ADMIN_API_KEY: 'anthropic-admin',
      OPENAI_ADMIN_API_KEY: 'openai-admin',
      QODER_ADMIN_API_KEY: 'qoder-admin',
      QODER_ORGANIZATION_ID: 'org',
      QODER_MEMBER_ID: 'member'
    })
    expect(env).not.toHaveProperty('ANTHROPIC_ADMIN_API_KEY')
    expect(env).not.toHaveProperty('OPENAI_ADMIN_API_KEY')
    expect(env).not.toHaveProperty('QODER_ADMIN_API_KEY')
    expect(env).not.toHaveProperty('QODER_ORGANIZATION_ID')
    expect(env).not.toHaveProperty('QODER_MEMBER_ID')
  })

  it('does not infer PI_AGENT_PI from an unverified shell assignment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-bootstrap-'))
    try {
      const launcher = join(dir, 'pi-agent')
      const bootstrap = join(dir, 'pi')
      const unrelated = join(dir, 'not-a-package-cli')
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      writeFileSync(unrelated, '#!/bin/sh\nexit 0\n')
      writeFileSync(bootstrap, `#!/bin/sh\nPI_AGENT_PI=${unrelated}\nexec ${launcher} "$@"\n`)
      chmodSync(launcher, 0o755)
      chmodSync(unrelated, 0o755)
      chmodSync(bootstrap, 0o755)

      const env = await piRpcEnvironment(piProfileForExecutable(launcher), { PATH: dir, HOME: dir })
      expect(env.PI_AGENT_PI).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not block prompt dispatch or process convergence on optional model telemetry', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'hold-model-query'), '')
      const startedAt = Date.now()
      const envSpy = vi.spyOn(shellEnvironment, 'shellEnv').mockReturnValue({ ...(process.env as Record<string, string>) })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      try {
        const handle = adapter.run({
          runId: 'run-delayed-model-query', prompt: 'hello', cwd, agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: vi.fn()
        })
        await vi.waitFor(() => expect(existsSync(join(cwd, 'prompt-received'))).toBe(true), { timeout: 10_000 })
        expect(Date.now() - startedAt).toBeLessThan(10_000)
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
      } finally {
        await adapter.dispose?.()
        envSpy.mockRestore()
      }
    })
  }, 15_000)

  it('probes native models, permissions, commands and skills without overriding Pi project trust', async () => {
    await withFixture(async (profile, cwd) => {
      const probe = await probePiAgent(profile, cwd)
      expect(probe).toMatchObject({ levels: ['off', 'high'], models: [{ id: 'test-model' }] })
      await expect(probePiAgent(profile)).resolves.toMatchObject({ state: { cwd: homedir() } })

      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.runControls!.read({ providerId: 'pi', agentProfileId: profile.id, cwd })).resolves.toMatchObject({
        state: 'ready',
        agentProfileId: profile.id,
        data: {
          models: [expect.objectContaining({ model: { providerId: 'openai-codex', id: 'test-model' } })],
          permissions: [expect.objectContaining({ id: 'full_access' })]
        }
      })
      await expect(adapter.skills!.list({ providerId: 'pi', agentProfileId: profile.id, cwd })).resolves.toMatchObject({
        data: expect.arrayContaining([
          { name: 'review', dir: '/repo/.pi/agent/skills/review', scope: 'project', description: 'Review code', enabled: true }
        ])
      })
      await expect(adapter.describe()).resolves.toMatchObject({ capabilities: { mcp: 'none' } })
      expect(adapter.mcp).toBeUndefined()
    })
  }, 20_000)

})
