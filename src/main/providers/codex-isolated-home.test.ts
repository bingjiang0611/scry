import {
  existsSync,
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
