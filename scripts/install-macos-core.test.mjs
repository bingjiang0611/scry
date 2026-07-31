import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBundle, installJournalName, installLockName, recoverInterruptedInstall } from './install-macos-core.mjs'

const roots = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'scry-installer-'))
  roots.push(value)
  return value
}
const bundle = (dir, value) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'marker'), value)
}
const marker = (dir) => readFileSync(join(dir, 'marker'), 'utf8')
const copyBundle = (source, target) => cpSync(source, target, { recursive: true, errorOnExist: true })
const validateBundle = (path) => {
  if (!existsSync(join(path, 'marker'))) throw new Error('invalid bundle')
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('macOS installer transaction', () => {
  it('stages and validates before replacing, then retains one recoverable backup', () => {
    const dir = root()
    const source = join(dir, 'source.app')
    const installRoot = join(dir, 'Applications')
    bundle(source, 'new')
    bundle(join(installRoot, 'Scry.app'), 'old')
    const result = installBundle({ source, installRoot, copyBundle, validateBundle, registerBundle: () => {} })
    expect(marker(result.target)).toBe('new')
    expect(marker(result.backup)).toBe('old')
    expect(existsSync(join(installRoot, installJournalName))).toBe(false)
    expect(existsSync(join(installRoot, installLockName))).toBe(false)
  })

  it('leaves the old app untouched when copy or validation fails', () => {
    const dir = root()
    const source = join(dir, 'source.app')
    const installRoot = join(dir, 'Applications')
    bundle(source, 'new')
    bundle(join(installRoot, 'Scry.app'), 'old')
    expect(() => installBundle({
      source,
      installRoot,
      copyBundle: () => { throw new Error('disk full') },
      validateBundle,
      registerBundle: () => {}
    })).toThrow('disk full')
    expect(marker(join(installRoot, 'Scry.app'))).toBe('old')
    expect(existsSync(join(installRoot, installLockName))).toBe(false)
  })

  it('rolls back the old app when registration fails', () => {
    const dir = root()
    const source = join(dir, 'source.app')
    const installRoot = join(dir, 'Applications')
    bundle(source, 'new')
    bundle(join(installRoot, 'Scry.app'), 'old')
    const registerBundle = vi.fn(() => { throw new Error('lsregister failed') })
    expect(() => installBundle({ source, installRoot, copyBundle, validateBundle, registerBundle })).toThrow('lsregister failed')
    expect(marker(join(installRoot, 'Scry.app'))).toBe('old')
    expect(existsSync(join(installRoot, installJournalName))).toBe(false)
  })

  it('recovers the crash window after target was renamed to backup', () => {
    const dir = root()
    const installRoot = join(dir, 'Applications')
    const target = join(installRoot, 'Scry.app')
    const backup = join(installRoot, '.Scry.app.backup')
    const stagingName = '.Scry.app.staging-crash'
    bundle(target, 'old')
    bundle(join(installRoot, stagingName), 'new')
    renameSync(target, backup)
    writeFileSync(join(installRoot, installJournalName), JSON.stringify({
      version: 1, phase: 'prepared', hadTarget: true, stagingName
    }))
    expect(recoverInterruptedInstall({ installRoot }).recovered).toBe(true)
    expect(marker(target)).toBe('old')
    expect(existsSync(join(installRoot, stagingName))).toBe(false)
  })

  it('recovers an incomplete staging copy recorded before the target is touched', () => {
    const dir = root()
    const installRoot = join(dir, 'Applications')
    const target = join(installRoot, 'Scry.app')
    const stagingName = '.Scry.app.staging-copy-crash'
    bundle(target, 'old')
    bundle(join(installRoot, stagingName), 'partial')
    writeFileSync(join(installRoot, installJournalName), JSON.stringify({
      version: 1, phase: 'prepared', hadTarget: true, stagingName
    }))

    expect(recoverInterruptedInstall({ installRoot }).recovered).toBe(true)
    expect(marker(target)).toBe('old')
    expect(existsSync(join(installRoot, stagingName))).toBe(false)
    expect(existsSync(join(installRoot, installJournalName))).toBe(false)
  })

  it('rejects a concurrent installer before it can touch the shared journal or target', () => {
    const dir = root()
    const source = join(dir, 'source.app')
    const installRoot = join(dir, 'Applications')
    bundle(source, 'new')
    bundle(join(installRoot, 'Scry.app'), 'old')

    const result = installBundle({
      source,
      installRoot,
      copyBundle: (from, to) => {
        expect(() => installBundle({
          source,
          installRoot,
          copyBundle,
          validateBundle,
          registerBundle: () => {}
        })).toThrow('另一个 Scry 安装正在进行')
        copyBundle(from, to)
      },
      validateBundle,
      registerBundle: () => {}
    })

    expect(marker(result.target)).toBe('new')
    expect(marker(result.backup)).toBe('old')
    expect(existsSync(join(installRoot, installJournalName))).toBe(false)
    expect(existsSync(join(installRoot, installLockName))).toBe(false)
  })

  it('recovers a lock only after its owner process is confirmed dead', () => {
    const dir = root()
    const source = join(dir, 'source.app')
    const installRoot = join(dir, 'Applications')
    bundle(source, 'new')
    bundle(join(installRoot, 'Scry.app'), 'old')
    writeFileSync(join(installRoot, installLockName), `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      token: '00000000-0000-4000-8000-000000000001'
    })}\n`)

    const result = installBundle({ source, installRoot, copyBundle, validateBundle, registerBundle: () => {} })
    expect(marker(result.target)).toBe('new')
    expect(existsSync(join(installRoot, installLockName))).toBe(false)
  })
})
