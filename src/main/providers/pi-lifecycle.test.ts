import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, onTestFailed, vi } from 'vitest'
import * as recorder from '../../core/turn-recorder/recorder'
import { recoverManagedRecorderTurns } from '../../core/turn-recorder/managed'
import type { ProviderRunHandle } from './types'
import type { TraceEvent } from '../../shared/trace'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { withProbeFixture } from './pi-rpc.fixture'
import * as locate from '../claude-locate'
import { createPiAdapter, probePiAgent } from './pi'


describe('Pi startup and probe lifecycle', () => {
  it.each(['continue', 'interrupt', 'transport-exit'] as const)('keeps async child ownership through parent idle: %s', async (action) => {
    await withProbeFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const events: TraceEvent[] = []
      const startedAt = Date.now()
      onTestFailed(() => {
        const commands = join(cwd, 'commands')
        console.error('Pi idle-child lifecycle evidence', JSON.stringify({ action, elapsedMs: Date.now() - startedAt,
          events: events.map(event => ({ stage: event.stage, ms: Date.parse(event.ts) - startedAt })).slice(-24),
          commands: existsSync(commands) ? readFileSync(commands, 'utf8').slice(-4000) : 'not created' }))
      })
      let checkpoint!: () => void
      const waiting = new Promise<void>(resolve => { checkpoint = resolve })
      const handle = adapter.run({
        runId: 'background', prompt: 'background-child', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit(event) {
          events.push(event)
          if (event.text?.includes('child waiting checkpoint')) checkpoint()
        }
      })
      try {
        await Promise.race([waiting, handle.promise.then(() => { throw new Error('run ended before child checkpoint') })])
        expect(events.filter(event => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({
          providerId: 'pi', phase: 'waiting', taskStop: 'unavailable', tasks: [{ taskId: 'child-1', description: 'worker' }]
        })
        expect(events.some(event => event.stage === 'result')).toBe(false)
        if (action === 'interrupt') handle.interrupt()
        else {
          // A missing reader must fail the fixture, not block Vitest's event loop
          // indefinitely inside writeFileSync on a FIFO.
          const release = spawnSync('/bin/sh', ['-c', 'printf "%s\\n" "$1" > "$2"', 'release-child',
            action === 'transport-exit' ? 'exit' : 'continue', join(cwd, 'release-child')], { timeout: 2_000 })
          expect(release.error).toBeUndefined()
          expect(release.status).toBe(0)
        }
        if (action === 'transport-exit') {
          await expect(handle.promise).rejects.toThrow()
          expect(events.filter(event => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({
            phase: 'inactive', tasks: [{ taskId: 'child-1', status: 'unconfirmed' }]
          })
          expect(events.some(event => event.stage === 'result')).toBe(false)
        } else await expect(handle.promise).resolves.toMatchObject({ status: action === 'interrupt' ? 'interrupted' : 'completed' })
        if (action === 'continue') {
          expect(events.some(event => event.text === 'Child reviewed; parent continued')).toBe(true)
          expect(events.filter(event => event.stage === 'result')).toHaveLength(1)
        }
      } finally {
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
      }
    })
  })

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

  it('keeps a completed read-only probe owned until exit when TERM is ignored', async () => {
    await withProbeFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'stubborn'), '')
      const kill = vi.spyOn(process, 'kill')
      try {
        const result = await probePiAgent(profile, cwd)
        expect(result.commands).toEqual([{ name: 'fixture-menu', source: 'extension' }])
        const pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
        const ownedSignals = kill.mock.calls.filter(([target]) => Math.abs(target) === pid).map(([, signal]) => signal)
        expect(ownedSignals).toContain('SIGTERM')
        expect(ownedSignals).toContain('SIGKILL')
        expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
        expect(readFileSync(join(cwd, 'commands'), 'utf8').trim().split('\n')).toHaveLength(4)
      } finally { kill.mockRestore() }
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

  it('does not advertise an unpersisted startup id, so the next send starts a real session', async () => {
    await withProbeFixture(async (profile, cwd, starts) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const onSession = vi.fn()
      const handle = adapter.run({
        runId: 'stop-before-persist', prompt: 'must not run', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', onExternalSessionId: onSession,
        emit: (event) => { if (event.stage === 'runtime:init') handle.interrupt() }
      })
      const stopped = await handle.promise
      expect(stopped).toMatchObject({ stopped: true, status: 'interrupted' })
      expect(stopped.externalSessionId).toBeUndefined()
      expect(handle.getExternalSessionId!()).toBeUndefined()
      expect(onSession).not.toHaveBeenCalled()
      expect(existsSync(join(cwd, 'fixture-session.jsonl'))).toBe(false)

      const next = adapter.run({
        runId: 'next-send', prompt: 'run now', cwd, agentProfileId: profile.id,
        resume: stopped.externalSessionId, attachments: [], permissionMode: 'full_access',
        emit: vi.fn(), onExternalSessionId: onSession
      })
      await expect(next.promise).resolves.toMatchObject({ externalSessionId: 'fixture-session', status: 'completed' })
      expect(onSession).toHaveBeenCalledExactlyOnceWith('fixture-session')
      expect(existsSync(join(cwd, 'fixture-session.jsonl'))).toBe(true)
      expect(starts()).toHaveLength(2)
    })
  })

  it('does not advertise a fresh menu-only session that has never persisted a conversation', async () => {
    await withProbeFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const onSession = vi.fn()
      const handle = adapter.run({
        runId: 'fresh-menu', prompt: '/fixture-menu', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn(), onExternalSessionId: onSession
      })
      const result = await handle.promise
      expect(result.status).toBe('completed')
      expect(result.externalSessionId).toBeUndefined()
      expect(handle.getExternalSessionId!()).toBeUndefined()
      expect(onSession).not.toHaveBeenCalled()
      expect(existsSync(join(cwd, 'fixture-session.jsonl'))).toBe(false)
    })
  })

  it('preserves a persisted resume id even when stopped during initialization', async () => {
    await withProbeFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'fixture-session.jsonl'), [
        { type: 'session', id: 'fixture-session' },
        { type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'previous prompt' } }
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const onSession = vi.fn()
      const handle = adapter.run({
        runId: 'stop-resumed', prompt: 'must not run', cwd, agentProfileId: profile.id,
        resume: 'fixture-session', attachments: [], permissionMode: 'full_access', onExternalSessionId: onSession,
        emit: (event) => { if (event.stage === 'runtime:init') handle.interrupt() }
      })
      await expect(handle.promise).resolves.toMatchObject({ externalSessionId: 'fixture-session', status: 'interrupted' })
      expect(onSession).toHaveBeenCalledExactlyOnceWith('fixture-session')
      expect(readFileSync(join(cwd, 'commands'), 'utf8').split('\n')).not.toContain('prompt')
    })
  })

  it('preserves the first native prompt if stopped before its RPC acknowledgement', async () => {
    await withProbeFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const onSession = vi.fn()
      const handle = adapter.run({
        runId: 'stop-after-persist', prompt: 'stop-after-persist', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', onExternalSessionId: onSession,
        // Terminate at the exact native persistence marker, without waiting for the
        // fixture's deliberately withheld prompt acknowledgement or abort lifecycle.
        emit: (event) => { if (event.stage === 'runtime:extension_ui') handle.forceKill!() }
      })
      await expect(handle.promise).resolves.toMatchObject({ externalSessionId: 'fixture-session', status: 'interrupted' })
      expect(onSession).toHaveBeenCalledExactlyOnceWith('fixture-session')
      expect(existsSync(join(cwd, 'fixture-session.jsonl'))).toBe(true)
    })
  })

  it('does not silently replace a missing resumed session with a new one', async () => {
    await withProbeFixture(async (profile, cwd, starts) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const onSession = vi.fn()
      const handle = adapter.run({
        runId: 'missing-resume', prompt: 'must not run', cwd, agentProfileId: profile.id,
        resume: 'fixture-session', attachments: [], permissionMode: 'full_access', emit: vi.fn(),
        onExternalSessionId: onSession
      })
      await expect(handle.promise).rejects.toThrow("No session found matching 'fixture-session'")
      expect(onSession).not.toHaveBeenCalled()
      expect(existsSync(join(cwd, 'commands'))).toBe(false)
      expect(existsSync(join(cwd, 'fixture-session.jsonl'))).toBe(false)
      expect(starts()).toHaveLength(1)
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
