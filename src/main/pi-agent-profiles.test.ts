import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPiAgentProfileStore, piProfileForExecutable, undetectedPiProfiles } from './pi-agent-profiles'

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
  it('retains a saved historical profile when Rotom is detected under its built-in ID', () => {
    const saved = { id: 'pi:564f7a994e4e34da', label: 'Pi · Rotom', executable: '/bin/rotom' }
    expect(undetectedPiProfiles([saved], [{ id: 'pi:rotom' }])).toEqual([saved])
    expect(undetectedPiProfiles([saved], [{ id: saved.id }])).toEqual([])
  })
})
