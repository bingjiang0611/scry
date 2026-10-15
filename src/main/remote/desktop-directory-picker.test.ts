import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listDesktopDirectories, parseDesktopDirectoryQuery, selectDesktopDirectory } from './desktop-directory-picker'
import { listRemoteDirectories, resolveRemoteProjectDirectory } from './remote-directory-browser'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'scry-directory-picker-'))
  roots.push(root)
  return realpathSync(root)
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('authenticated desktop directory picker filesystem boundary', () => {
  it('browses new locations without granting them, and only selection persists their canonical directory', () => {
    const root = fixture()
    const granted = join(root, 'existing')
    const custom = join(root, 'custom ; literal')
    mkdirSync(granted); mkdirSync(custom)
    symlinkSync(custom, join(root, 'directory-link'))
    writeFileSync(join(root, 'file.txt'), 'not a directory')
    symlinkSync(join(root, 'file.txt'), join(root, 'file-link'))
    symlinkSync(join(root, 'missing'), join(root, 'broken-link'))
    const known = new Set([granted])
    const remember = vi.fn((path: string) => { known.add(path) })
    const listing = listDesktopDirectories({ action: 'list', path: root })
    expect(listing.directories.map(item => item.label)).toEqual(['custom ; literal', 'directory-link', 'existing'])
    expect(remember).not.toHaveBeenCalled()
    expect(() => resolveRemoteProjectDirectory(custom, known)).toThrow('工作目录不在 Scry 已授权项目内')
    // The old mobile browser still cannot explore a parent outside its grants.
    expect(() => listRemoteDirectories(root, known)).toThrow('workspace_not_authorized')
    const selected = selectDesktopDirectory(join(root, 'directory-link'), remember)
    expect(selected).toEqual({ path: custom, label: 'custom ; literal' })
    expect(remember).toHaveBeenCalledExactlyOnceWith(custom)
    expect(resolveRemoteProjectDirectory(custom, known)).toBe(custom)
  })

  it('returns bounded stable pages, detects directory changes, and has a real root boundary', () => {
    const root = fixture()
    for (let index = 0; index < 105; index++) mkdirSync(join(root, `folder-${index}`))
    const first = listDesktopDirectories({ action: 'list', path: root })
    expect(first).toMatchObject({ cursor: 100, total: 105, hasMore: true })
    expect(first.directories).toHaveLength(100)
    const last = listDesktopDirectories({ action: 'list', path: root, cursor: first.cursor, snapshot: first.snapshot })
    expect(last).toMatchObject({ cursor: 105, total: 105, hasMore: false })
    expect(new Set([...first.directories, ...last.directories].map(item => item.path)).size).toBe(105)
    mkdirSync(join(root, 'new-folder'))
    expect(() => listDesktopDirectories({ action: 'list', path: root, cursor: 100, snapshot: first.snapshot })).toThrow('directory_snapshot_changed')
    expect(listDesktopDirectories({ action: 'list', path: '/' }).parent).toBeUndefined()
  })

  it('rejects invalid, missing and file targets before persisting, and exposes persistence failures', () => {
    const root = fixture()
    const file = join(root, 'file')
    writeFileSync(file, 'text')
    const remember = vi.fn()
    for (const path of ['relative', join(root, 'missing'), file]) expect(() => selectDesktopDirectory(path, remember)).toThrow()
    expect(remember).not.toHaveBeenCalled()
    remember.mockImplementation(() => { throw new Error('disk_full') })
    expect(() => selectDesktopDirectory(root, remember)).toThrow('disk_full')
  })

  it('rejects unreadable directories before a grant', () => {
    const root = fixture()
    const denied = join(root, 'denied')
    mkdirSync(denied)
    const remember = vi.fn()
    chmodSync(denied, 0)
    try {
      expect(() => selectDesktopDirectory(denied, remember)).toThrow()
      expect(remember).not.toHaveBeenCalled()
    } finally { chmodSync(denied, 0o700) }
  })

  it('validates wire operations, path size, cursor and snapshot before filesystem calls', () => {
    expect(parseDesktopDirectoryQuery({ action: 'list' })).toEqual({ action: 'list' })
    expect(parseDesktopDirectoryQuery({ action: 'select', path: '~/project' })).toEqual({ action: 'select', path: '~/project' })
    for (const query of [null, [], { action: 'execute', path: '/' }, { action: 'select', path: '' }, { action: 'list', path: 'a\0b' }, { action: 'select', path: 'a'.repeat(4097) }, { action: 'list', cursor: -1 }, { action: 'list', cursor: 1 }, { action: 'list', snapshot: 'not-a-hash' }]) {
      expect(() => parseDesktopDirectoryQuery(query)).toThrow()
    }
  })
})
