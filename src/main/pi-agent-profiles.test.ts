import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as agentDiscovery from './claude-locate'
import { createPiProfileRuntime } from './bootstrap/pi-profiles'
import { canonicalizePiAgentPaths, createPiAgentProfileStore, piProfileForExecutable, resolvePiLauncherExecutable, undetectedPiProfiles } from './pi-agent-profiles'

describe('Pi Agent Profile store', () => {
  it('uses the canonical executable path as stable identity and persists profiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-profile-'))
    try {
      const executable = join(dir, 'dev-agent')
      writeFileSync(executable, '#!/bin/sh\nexit 0\n')
      chmodSync(executable, 0o755)
      const profile = piProfileForExecutable(executable)
      const store = createPiAgentProfileStore(dir)

      expect(profile).toMatchObject({ id: expect.stringMatching(/^pi:[a-f0-9]{16}$/), label: 'Pi · dev-agent' })
      expect(store.add(profile)).toEqual(profile)
      expect(store.resolve(profile.id)).toEqual(profile)

      store.add({ ...profile, label: 'Dev Agent' })
      expect(store.load()).toEqual([{ ...profile, label: 'Dev Agent' }])
      store.remove(profile.id)
      expect(store.load()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-executable launcher', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-profile-'))
    try {
      const executable = join(dir, 'not-executable')
      writeFileSync(executable, 'nope')
      expect(() => piProfileForExecutable(executable)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Pi profile discovery identity', () => {
  it.each(['pi', 'rotom'])('resolves the mise %s shim before canonicalizing or launching RPC', async (command) => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-mise space-'))
    try {
      const mise = join(dir, 'mise')
      const shim = join(dir, command)
      const installed = join(dir, 'installed launcher')
      const log = join(dir, 'mise-argv.json')
      writeFileSync(installed, '#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = --mode ] && [ "$2" = rpc ] || exit 9\nprintf "rpc-ready"\n', { mode: 0o755 })
      writeFileSync(mise, `#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = which ] && [ "$2" = ${command} ] || exit 2\nprintf '%s' "$PWD" > '${log}'\nprintf '%s\\n' '${installed}'\n`, { mode: 0o755 })
      symlinkSync(mise, shim)
      const agent = { id: command === 'pi' ? 'pi:default' : 'pi:rotom', name: command, bin: command, path: shim }
      const [detected] = await canonicalizePiAgentPaths([agent])
      expect(detected).toEqual({ ...agent, path: realpathSync(installed) })
      expect(readFileSync(log, 'utf8')).toBe(realpathSync(homedir()))
      // The file-picker path must resolve to the same profile identity as discovery.
      const profile = piProfileForExecutable(await resolvePiLauncherExecutable(shim))
      expect(profile.executable).toBe(detected.path)
      const discovery = vi.spyOn(agentDiscovery, 'detectAgentsFast').mockReturnValue([agent])
      try {
        const runtime = createPiProfileRuntime({ userDataDir: dir })
        expect(await runtime.resolvePiProfile(agent.id)).toMatchObject({ id: agent.id, executable: profile.executable })
        expect(await runtime.listPiProfiles()).toEqual([expect.objectContaining({ id: agent.id, executable: profile.executable })])
      } finally {
        discovery.mockRestore()
      }
      const result = await promisify(execFile)(profile.executable, ['--mode', 'rpc'])
      expect(result.stdout).toBe('rpc-ready')
      expect(() => piProfileForExecutable(shim)).toThrow('mise')
      expect(() => piProfileForExecutable(mise)).toThrow('mise')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not launch mise when shim resolution fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-mise-failed-'))
    try {
      const mise = join(dir, 'mise')
      const shim = join(dir, 'rotom')
      writeFileSync(mise, '#!/bin/sh\necho "not installed" >&2\nexit 1\n', { mode: 0o755 })
      symlinkSync(mise, shim)
      await expect(resolvePiLauncherExecutable(shim)).rejects.toThrow('not installed')
      const agent = { id: 'pi:rotom', name: 'Rotom', bin: 'rotom', path: shim }
      expect(await canonicalizePiAgentPaths([agent])).toEqual([agent])
      expect(() => piProfileForExecutable(shim)).toThrow('mise')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('canonicalizes Pi launchers without losing built-in or saved history IDs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-alias-'))
    try {
      const executable = join(dir, 'default.sh')
      const launcher = join(dir, 'rotom')
      writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      symlinkSync(executable, launcher)
      const store = createPiAgentProfileStore(dir)
      const saved = store.add(piProfileForExecutable(launcher))
      const detected = { id: 'pi:rotom', name: 'Rotom', bin: 'rotom', path: launcher }
      const claude = { id: 'claude', name: 'Claude', bin: 'claude', path: launcher }
      const agents = await canonicalizePiAgentPaths([detected, claude])

      expect(agents[0]).toEqual({ ...detected, path: realpathSync(executable) })
      expect(agents[0].path).toBe(saved.executable)
      expect(agents[1]).toBe(claude)
      expect(undetectedPiProfiles(store.load(), agents)).toEqual([saved])
      expect(store.resolve(saved.id)).toEqual(saved)
      expect(detected.path).toBe(launcher)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves discovery evidence when a launcher disappears before canonicalization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-missing-'))
    try {
      const agent = { id: 'pi:rotom', name: 'Rotom', bin: 'rotom', path: join(dir, 'missing') }
      expect(await canonicalizePiAgentPaths([agent])).toEqual([agent])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('retains a saved historical profile when Rotom is detected under its built-in ID', () => {
    const saved = { id: 'pi:564f7a994e4e34da', label: 'Pi · Rotom', executable: '/bin/rotom' }
    expect(undetectedPiProfiles([saved], [{ id: 'pi:rotom' }])).toEqual([saved])
    expect(undetectedPiProfiles([saved], [{ id: saved.id }])).toEqual([])
  })
})
