import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexIsolatedHome } from './codex-isolated-home'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

describe('createCodexIsolatedHome', () => {
  it('shares required native state but keeps sessions local and excludes MCP injection sources', () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-codex-source-'))
    const persistent = mkdtempSync(join(tmpdir(), 'scry-codex-persistent-'))
    cleanups.push(() => rmSync(source, { recursive: true, force: true }))
    cleanups.push(() => rmSync(persistent, { recursive: true, force: true }))
    writeFileSync(join(source, 'auth.json'), '{}')
    writeFileSync(join(source, 'config.toml'), '[mcp_servers.evil]\ncommand="evil"\n')
    mkdirSync(join(source, 'sessions'))
    writeFileSync(join(source, 'sessions', 'native.jsonl'), 'native')
    mkdirSync(join(source, 'archived_sessions'))
    mkdirSync(join(source, 'plugins'))
    writeFileSync(join(persistent, 'config.toml'), '[mcp_servers.stale]\ncommand="stale"\n')
    mkdirSync(join(persistent, 'plugins'))
    writeFileSync(join(persistent, 'state_5.sqlite'), 'state')

    const isolated = createCodexIsolatedHome(source, persistent)
    cleanups.push(isolated.cleanup)

    expect(readlinkSync(join(isolated.path, 'auth.json'))).toBe(realpathSync(join(source, 'auth.json')))
    expect(existsSync(join(isolated.path, 'sessions', 'native.jsonl'))).toBe(false)
    expect(existsSync(join(isolated.path, 'archived_sessions'))).toBe(true)
    expect(existsSync(join(isolated.path, 'config.toml'))).toBe(false)
    expect(existsSync(join(isolated.path, 'plugins'))).toBe(false)

    writeFileSync(join(isolated.path, 'sessions', 'scry.jsonl'), 'scry')
    isolated.cleanup()
    const reopened = createCodexIsolatedHome(source, persistent)
    cleanups.push(reopened.cleanup)
    expect(existsSync(join(reopened.path, 'sessions', 'scry.jsonl'))).toBe(true)
    expect(readFileSync(join(reopened.path, 'state_5.sqlite'), 'utf8')).toBe('state')
  })

  it('links persistent shared state to the canonical source instead of an ephemeral symlink', () => {
    const native = mkdtempSync(join(tmpdir(), 'scry-codex-native-'))
    const source = mkdtempSync(join(tmpdir(), 'scry-codex-source-'))
    const persistent = mkdtempSync(join(tmpdir(), 'scry-codex-persistent-'))
    cleanups.push(() => rmSync(native, { recursive: true, force: true }))
    cleanups.push(() => rmSync(source, { recursive: true, force: true }))
    cleanups.push(() => rmSync(persistent, { recursive: true, force: true }))
    writeFileSync(join(native, 'auth.json'), '{"account":"fixture"}')
    symlinkSync(join(native, 'auth.json'), join(source, 'auth.json'))

    createCodexIsolatedHome(source, persistent)

    expect(readlinkSync(join(persistent, 'auth.json'))).toBe(realpathSync(join(native, 'auth.json')))
    rmSync(source, { recursive: true, force: true })
    expect(readFileSync(join(persistent, 'auth.json'), 'utf8')).toBe('{"account":"fixture"}')
  })

  it('rejects a persistent root symlink before touching the native home', () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-codex-source-'))
    const parent = mkdtempSync(join(tmpdir(), 'scry-codex-parent-'))
    const persistent = join(parent, 'codex-home-v1')
    cleanups.push(() => rmSync(source, { recursive: true, force: true }))
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }))
    writeFileSync(join(source, 'config.toml'), 'keep')
    symlinkSync(source, persistent, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => createCodexIsolatedHome(source, persistent)).toThrow('not a symlink')
    expect(readFileSync(join(source, 'config.toml'), 'utf8')).toBe('keep')
  })

  it('rejects either parent-child overlap before removing native state', () => {
    const persistentParent = mkdtempSync(join(tmpdir(), 'scry-codex-parent-'))
    const nestedSource = join(persistentParent, 'plugins')
    mkdirSync(nestedSource)
    writeFileSync(join(nestedSource, 'config.toml'), 'keep-nested-source')
    cleanups.push(() => rmSync(persistentParent, { recursive: true, force: true }))

    expect(() => createCodexIsolatedHome(nestedSource, persistentParent)).toThrow('must not overlap')
    expect(readFileSync(join(nestedSource, 'config.toml'), 'utf8')).toBe('keep-nested-source')

    const sourceParent = mkdtempSync(join(tmpdir(), 'scry-codex-source-'))
    const nestedPersistent = join(sourceParent, 'scry-home')
    cleanups.push(() => rmSync(sourceParent, { recursive: true, force: true }))
    expect(() => createCodexIsolatedHome(sourceParent, nestedPersistent)).toThrow('must not overlap')
  })

  it('copies only catalog-owned legacy rollouts and never overwrites stable history', () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-codex-source-'))
    const persistent = mkdtempSync(join(tmpdir(), 'scry-codex-persistent-'))
    const activeId = '019fac8c-b58e-7042-83f6-800768aba871'
    const archivedId = '019fb20c-14ff-7e21-bb6f-c904048ad469'
    const otherId = '019fad2e-0aeb-7a20-9c3e-cbeb0a49dde8'
    const activeName = `rollout-2026-07-29T14-25-30-${activeId}.jsonl`
    const archivedName = `rollout-2026-07-30T16-02-44-${archivedId}.jsonl`
    const otherName = `rollout-2026-07-29T17-21-44-${otherId}.jsonl`
    const sourceActiveDir = join(source, 'sessions', '2026', '07', '29')
    mkdirSync(sourceActiveDir, { recursive: true })
    mkdirSync(join(source, 'archived_sessions'))
    writeFileSync(join(sourceActiveDir, activeName), 'legacy-active')
    writeFileSync(join(sourceActiveDir, otherName), 'not-owned')
    writeFileSync(join(source, 'archived_sessions', archivedName), 'legacy-archived')
    cleanups.push(() => rmSync(source, { recursive: true, force: true }))
    cleanups.push(() => rmSync(persistent, { recursive: true, force: true }))

    createCodexIsolatedHome(source, persistent, [activeId, archivedId, 'not-a-thread-id'])
    const targetActive = join(persistent, 'sessions', '2026', '07', '29', activeName)
    const targetArchived = join(persistent, 'archived_sessions', archivedName)
    expect(readFileSync(targetActive, 'utf8')).toBe('legacy-active')
    expect(lstatSync(targetActive).isSymbolicLink()).toBe(false)
    expect(readFileSync(targetArchived, 'utf8')).toBe('legacy-archived')
    expect(existsSync(join(persistent, 'sessions', '2026', '07', '29', otherName))).toBe(false)

    writeFileSync(targetActive, 'stable-newer')
    writeFileSync(join(sourceActiveDir, activeName), 'legacy-older')
    createCodexIsolatedHome(source, persistent, [activeId])
    expect(readFileSync(targetActive, 'utf8')).toBe('stable-newer')
  })

  it('rejects a session-root symlink and leaves its target intact', () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-codex-source-'))
    const persistent = mkdtempSync(join(tmpdir(), 'scry-codex-persistent-'))
    mkdirSync(join(source, 'sessions'))
    writeFileSync(join(source, 'sessions', 'native.jsonl'), 'keep')
    symlinkSync(join(source, 'sessions'), join(persistent, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir')
    cleanups.push(() => rmSync(source, { recursive: true, force: true }))
    cleanups.push(() => rmSync(persistent, { recursive: true, force: true }))

    expect(() => createCodexIsolatedHome(source, persistent)).toThrow('sessions must be a local directory')
    expect(readFileSync(join(source, 'sessions', 'native.jsonl'), 'utf8')).toBe('keep')
  })

  it('removes an ephemeral home on cleanup', () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-codex-source-'))
    cleanups.push(() => rmSync(source, { recursive: true, force: true }))
    const isolated = createCodexIsolatedHome(source)
    expect(existsSync(isolated.path)).toBe(true)
    isolated.cleanup()
    expect(existsSync(isolated.path)).toBe(false)
  })
})
