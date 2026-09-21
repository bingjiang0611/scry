import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import * as recorder from '../../core/turn-recorder/recorder'
import { recoverManagedRecorderTurns } from '../../core/turn-recorder/managed'
import type { ProviderRunHandle } from './types'
import { piProfileForExecutable, type PiAgentProfile } from '../pi-agent-profiles'
import * as locate from '../claude-locate'
import { createPiAdapter, probePiAgent } from './pi'

async function withProbeFixture(run: (profile: PiAgentProfile, cwd: string, starts: () => string[]) => Promise<void>) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'scry-pi-lifecycle-')))
  const executable = join(cwd, 'fixture-pi')
  const log = join(cwd, 'starts.jsonl')
  writeFileSync(log, '')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.cwd()) + '\\n')
fs.writeFileSync(process.cwd() + '/pid', String(process.pid))
if (fs.existsSync(process.cwd() + '/startup-wire')) {
  fs.writeSync(1, fs.readFileSync(process.cwd() + '/startup-wire'))
  process.exit(0)
}
if (fs.existsSync(process.cwd() + '/stubborn')) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  fs.appendFileSync(process.cwd() + '/commands', command.type + '\\n')
  const fail = fs.existsSync(process.cwd() + '/fail-probe')
  const data = {
    get_state: { cwd: process.cwd(), sessionId: 'fixture-session' },
    get_entries: { entries: [], leafId: null },
    get_available_models: { models: [] },
    get_available_thinking_levels: { levels: ['off'] },
    get_commands: { commands: [] }
  }[command.type]
  process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type,
    success: !fail, data, ...(fail ? { error: 'fixture probe failed' } : {}) }) + '\\n')
})
`)
  chmodSync(executable, 0o755)
  // Lifecycle tests own their launcher: don't warm a login shell or scan the
  // developer's PATH for Node. The dedicated Node-selection test overrides this
  // boundary explicitly; RPC, process exit and recorder IO remain real.
  const environment = vi.spyOn(locate, 'shellEnv').mockReturnValue({
    PATH: dirname(process.execPath), HOME: cwd, PI_AGENT_NODE: process.execPath
  })
  try {
    await run(piProfileForExecutable(executable), cwd, () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string))
  } finally {
    environment.mockRestore()
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('Pi startup and probe lifecycle', () => {
  it('shares concurrent capability probes, but refreshes after the flight completes', async () => {
    await withProbeFixture(async (profile, cwd, starts) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const context = { providerId: 'pi' as const, agentProfileId: profile.id, cwd }
      const results = await Promise.all([
        adapter.skills!.list(context), adapter.commands!.list(context), adapter.runControls!.read(context)
      ])
      expect(results.map((result) => result.state)).toEqual(['ready', 'ready', 'ready'])
      expect(starts()).toHaveLength(1)
      await probePiAgent(profile, cwd)
      expect(starts()).toHaveLength(2)
    })
  })

  it('does not share probe evidence across workspaces, profile ids or executables', async () => {
    await withProbeFixture(async (profile, cwd, starts) => {
      const otherCwd = join(cwd, 'other')
      mkdirSync(otherCwd)
      const otherExecutable = join(cwd, 'other-pi')
      writeFileSync(otherExecutable, readFileSync(profile.executable))
      chmodSync(otherExecutable, 0o755)
      const results = await Promise.all([
        probePiAgent(profile, cwd), probePiAgent(profile, otherCwd),
        probePiAgent({ ...profile, id: 'pi:rotom' }, cwd),
        probePiAgent({ ...profile, executable: otherExecutable }, cwd)
      ])
      expect(results.map((result) => result.state.cwd)).toEqual([cwd, otherCwd, cwd, cwd])
      expect(starts()).toHaveLength(4)
    })
  })

  it('releases a failed flight so a later probe can recover', async () => {
    await withProbeFixture(async (profile, cwd, starts) => {
      writeFileSync(join(cwd, 'fail-probe'), '')
      const results = await Promise.allSettled([probePiAgent(profile, cwd), probePiAgent(profile, cwd)])
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
      expect(starts()).toHaveLength(1)
      rmSync(join(cwd, 'fail-probe'))
      await expect(probePiAgent(profile, cwd)).resolves.toMatchObject({ state: { cwd } })
      expect(starts()).toHaveLength(2)
    })
  })

  it.each([
    ['non-JSON output', 'not-json\n', /JSONL 解码失败.*expected a value/],
    ['null response', 'null\n', /非对象/],
    ['array response', '[]\n', /非对象/],
    ['unfinished frame', '{"type":', /JSONL 解码失败.*expected a value/],
    ['exit without evidence', '', /提前退出/]
  ] as const)('rejects %s, confirms process exit and allows a fresh probe', async (_name, wire, error) => {
    await withProbeFixture(async (profile, cwd, starts) => {
      writeFileSync(join(cwd, 'startup-wire'), wire)
      await expect(probePiAgent(profile, cwd)).rejects.toThrow(error)
      const pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      rmSync(join(cwd, 'startup-wire'))
      await expect(probePiAgent(profile, cwd)).resolves.toMatchObject({ state: { cwd } })
      expect(starts()).toHaveLength(2)
    })
  })

  it('never sends a prompt after stop during RPC initialization', async () => {
    await withProbeFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'stop-during-init', prompt: 'must not run', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access',
        emit: (event) => { if (event.stage === 'runtime:init') handle.interrupt() }
      })
      await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
      expect(readFileSync(join(cwd, 'commands'), 'utf8').split('\n')).not.toContain('prompt')
    })
  })

  it('cancels the exact provisional lifecycle when stopped while opening the recorder', async () => {
    await withProbeFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1, enabled: true, workspaceId: 'pi-stop-fixture', dataDir: '.scry',
        repositories: { mode: 'workspace-only' },
        capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
      }))
      let handle: ProviderRunHandle
      const original = recorder.handleRecorderHook
      const hook = vi.spyOn(recorder, 'handleRecorderHook').mockImplementationOnce(async (request) => {
        const opened = await original(request)
        expect(opened.status).toBe('started')
        handle.interrupt()
        return opened
      })
      try {
        const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
        const prompt = 'must not run'
        handle = adapter.run({
          runId: 'stop-after-recorder', prompt, cwd, agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: vi.fn(), managedRecorder: true,
          managedRecorderIdentity: { runId: 'stop-after-recorder', promptHash: createHash('sha256').update(prompt).digest('hex') }
        })
        await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
        expect(hook).toHaveBeenCalledOnce()
        expect(readFileSync(join(cwd, 'commands'), 'utf8').split('\n')).not.toContain('prompt')
        await expect(recoverManagedRecorderTurns(cwd, process.env, { provider: 'pi' }))
          .resolves.toEqual({ recovered: 0, pending: 0 })
      } finally {
        hook.mockRestore()
      }
    })
  })

  it('confirms exit before settling even if the launcher ignores stdin EOF, abort and SIGTERM', async () => {
    await withProbeFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'stubborn'), '')
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let pid: number | undefined
      try {
        const handle = adapter.run({
          runId: 'stubborn-stop', prompt: 'must not run', cwd, agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access',
          emit: (event) => {
            if (event.stage === 'runtime:init') {
              pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
              handle.interrupt()
            }
          }
        })
        await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
        expect(pid).toBeGreaterThan(0)
        expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      } finally {
        if (pid) {
          try { process.kill(pid, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
      }
    })
  }, 10_000)

  it('does not launch after a stop while asynchronously selecting Node', async () => {
    await withProbeFixture(async (profile, cwd, starts) => {
      let probeStarted!: () => void
      const started = new Promise<void>((resolve) => { probeStarted = resolve })
      let releaseVersion!: (version: string) => void
      const version = new Promise<string>((resolve) => { releaseVersion = resolve })
      const env = vi.spyOn(locate, 'shellEnv').mockReturnValue({ PATH: dirname(process.execPath), HOME: cwd })
      const probe = vi.spyOn(locate, 'execFileText').mockImplementationOnce(() => {
        probeStarted()
        return version
      })
      try {
        const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
        const handle = adapter.run({
          runId: 'stop-during-node', prompt: 'must not run', cwd, agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: vi.fn()
        })
        await started
        handle.interrupt()
        releaseVersion('24.18.0')
        await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
        expect(starts()).toEqual([])
      } finally {
        probe.mockRestore()
        env.mockRestore()
      }
    })
  })

  it.each(['interrupt', 'forceKill'] as const)('does not launch after %s during profile resolution', async (stop) => {
    await withProbeFixture(async (profile, cwd, starts) => {
      let resolveProfile!: (profile: PiAgentProfile) => void
      const pendingProfile = new Promise<PiAgentProfile>((resolve) => { resolveProfile = resolve })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: () => pendingProfile })
      const handle = adapter.run({
        runId: 'stop-before-launch', prompt: 'must not run', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })
      handle[stop]!()
      resolveProfile(profile)
      await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
      expect(starts()).toEqual([])
    })
  })
})
