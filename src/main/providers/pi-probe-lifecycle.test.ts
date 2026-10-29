import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withProbeFixture } from './pi-rpc.fixture'
import { createPiAdapter, probePiAgent } from './pi'
import { disposePiCatalog } from './pi-catalog'

describe('Pi capability probe lifecycle', () => {
  it('shares concurrent capability probes and answers later reads on the same live child', async () => {
    await withProbeFixture(async (profile, cwd, starts) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const context = { providerId: 'pi' as const, agentProfileId: profile.id, cwd }
      const results = await Promise.all([
        adapter.skills!.list(context), adapter.commands!.list(context), adapter.runControls!.read(context)
      ])
      expect(results.map((result) => result.state)).toEqual(['ready', 'ready', 'ready'])
      expect(starts()).toHaveLength(1)
      // A later read still asks the live child, but no second child is started for it.
      await expect(probePiAgent(profile, cwd)).resolves.toMatchObject({ state: { cwd } })
      expect(starts()).toHaveLength(1)
      expect(readFileSync(join(cwd, 'commands'), 'utf8').trim().split('\n')).toHaveLength(8)
      await adapter.dispose?.()
      expect(() => process.kill(Number(readFileSync(join(cwd, 'pid'), 'utf8')), 0))
        .toThrowError(expect.objectContaining({ code: 'ESRCH' }))
    })
  })

  it('invalidates one workspace without restarting an unrelated warm probe', async () => {
    await withProbeFixture(async (profile, cwd, starts) => {
      const otherCwd = join(cwd, 'other')
      mkdirSync(otherCwd)
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const context = { providerId: 'pi' as const, agentProfileId: profile.id, cwd }
      await probePiAgent(profile, cwd)
      await probePiAgent(profile, otherCwd)
      const firstPid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
      const otherPid = Number(readFileSync(join(otherCwd, 'pid'), 'utf8'))

      await adapter.invalidateContext?.(context)

      expect(() => process.kill(firstPid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
      expect(() => process.kill(otherPid, 0)).not.toThrow()
      await expect(probePiAgent(profile, otherCwd)).resolves.toMatchObject({ state: { cwd: otherCwd } })
      expect(starts()).toEqual([cwd, otherCwd])
      await expect(probePiAgent(profile, cwd)).resolves.toMatchObject({ state: { cwd } })
      expect(starts()).toEqual([cwd, otherCwd, cwd])
      await adapter.dispose?.()
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

  it('keeps a parked read-only probe owned until exit when TERM is ignored', async () => {
    await withProbeFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'stubborn'), '')
      const kill = vi.spyOn(process, 'kill')
      try {
        const result = await probePiAgent(profile, cwd)
        expect(result.commands).toEqual([{ name: 'fixture-menu', source: 'extension' }])
        const pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'))
        // The parked child is still owned; closing it must still escalate past an ignored TERM.
        expect(() => process.kill(pid, 0)).not.toThrow()
        await disposePiCatalog()
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
})
