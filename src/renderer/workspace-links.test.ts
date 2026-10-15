import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { HomeFileAccess } from '../main/home-file-access'
import { readWorkspaceFile, resolveWorkspaceFileOpenTarget } from '../main/workspace-files'
import { resolveWorkspaceFileReference, resolveWorkspaceFileTarget, resolveWorkspaceFileTargets } from './workspace-links'

describe('workspace file references', () => {
  const cwd = '/Users/example/project'

  it('resolves absolute, file URL and explicit workspace references inside cwd', () => {
    expect(resolveWorkspaceFileReference(cwd, '/Users/example/project/docs/report.pdf')).toBe('docs/report.pdf')
    expect(resolveWorkspaceFileReference(cwd, 'file:///Users/example/project/docs/report%20one.html')).toBe('docs/report one.html')
    expect(resolveWorkspaceFileReference(cwd, '@"docs/report one.md"')).toBe('docs/report one.md')
    expect(resolveWorkspaceFileReference(cwd, '@src/App.tsx')).toBe('src/App.tsx')
  })

  it('removes source locations before resolving paths and matching turn evidence', () => {
    const path = 'packages/coding-agent/src/modes/interactive/interactive-mode.ts'
    for (const suffix of ['#L1252', '#L1252-L1260', '#L1252C3-L1260C8', ':1252', ':1252:3', ':1252-1260']) {
      expect(resolveWorkspaceFileReference(cwd, `${path}${suffix}`)).toBe(path)
      expect(resolveWorkspaceFileReference(cwd, `@${cwd}/${path}${suffix}`)).toBe(path)
      expect(resolveWorkspaceFileTarget([cwd], `~/${path}${suffix}`)).toEqual({ cwd: '~', path })
      expect(resolveWorkspaceFileTargets([cwd], `interactive-mode.ts${suffix}`, [path])).toEqual([{ cwd, path }])
    }
    expect(resolveWorkspaceFileReference(cwd, `file://${cwd}/${path}#L1252`)).toBe(path)
    expect(resolveWorkspaceFileReference(cwd, '@"docs/source file.ts:12:3"')).toBe('docs/source file.ts')
  })

  it('opens source links through the real filesystem resolver without location suffixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-source-links-'))
    try {
      const path = 'packages/coding-agent/src/modes/interactive/interactive-mode.ts'
      await mkdir(join(root, 'packages/coding-agent/src/modes/interactive'), { recursive: true })
      await writeFile(join(root, path), 'export const source = true\n')
      const access = new HomeFileAccess(root)
      for (const suffix of ['#L1252', '#L1252-L1260', ':1252:3']) {
        const request = resolveWorkspaceFileTarget([root], `${path}${suffix}`)!
        const target = await resolveWorkspaceFileOpenTarget(request, access)
        expect(target).toEqual({ cwd: await realpath(root), path, mode: 'text' })
        expect((await readWorkspaceFile(target)).content).toBe('export const source = true\n')
      }
      await expect(resolveWorkspaceFileOpenTarget({ cwd: root, path: `${path}#L1252` }, access)).rejects.toThrow('不存在')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves literal hashes, colons and URL-encoded filenames instead of stripping arbitrary suffixes', () => {
    for (const path of ['docs/report#draft.md', 'docs/report:final.txt', 'docs/a%20b.txt']) {
      expect(resolveWorkspaceFileReference(cwd, path)).toBe(path)
    }
    // A file URL encodes literal filename punctuation separately from its location fragment.
    expect(resolveWorkspaceFileReference(cwd, `file://${cwd}/docs/source.ts%23L12#L4`)).toBe('docs/source.ts#L12')
    expect(resolveWorkspaceFileReference(cwd, `file://${cwd}/docs/source.ts%3A12`)).toBe('docs/source.ts:12')
  })

  it('accepts relative file paths of any extension while leaving plain identifiers alone', () => {
    expect(resolveWorkspaceFileReference(cwd, 'src/App.tsx')).toBe('src/App.tsx')
    expect(resolveWorkspaceFileReference(cwd, './README.md')).toBe('README.md')
    expect(resolveWorkspaceFileReference(cwd, 'README.md')).toBe('README.md')
    expect(resolveWorkspaceFileReference(cwd, 'package.json')).toBe('package.json')
    expect(resolveWorkspaceFileReference(cwd, 'vite.config.ts')).toBe('vite.config.ts')
    expect(resolveWorkspaceFileReference(cwd, 'Promise<void>')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, 'asset.custom')).toBe('asset.custom')
    expect(resolveWorkspaceFileReference(cwd, 'run.com')).toBe('run.com')
    expect(resolveWorkspaceFileReference(cwd, '.env')).toBe('.env')
    expect(resolveWorkspaceFileReference(cwd, 'assets/payload')).toBe('assets/payload')
    expect(resolveWorkspaceFileReference(cwd, 'identifier')).toBeNull()
  })

  it('matches abbreviated names against turn evidence, deduplicates targets and preserves explicit paths', () => {
    const files = [`${cwd}/designs/a/brief.md`, 'designs/a/brief.md', 'designs/b/brief.md', `${cwd}/brief.md`]
    expect(resolveWorkspaceFileTargets([cwd], 'brief.md', files)).toEqual([{ cwd, path: 'brief.md' }])
    expect(resolveWorkspaceFileTargets([cwd], 'brief.md', files.slice(0, 3))).toEqual([
      { cwd, path: 'designs/a/brief.md' }, { cwd, path: 'designs/b/brief.md' }
    ])
    expect(resolveWorkspaceFileTargets([cwd], './brief.md', files.slice(0, 3))).toEqual([{ cwd, path: 'brief.md' }])
    expect(resolveWorkspaceFileTargets([cwd], '~/brief.md', files)).toEqual([{ cwd: '~', path: 'brief.md' }])
    expect(resolveWorkspaceFileTargets([cwd], 'https://example.com/brief.md', files)).toEqual([])
    expect(resolveWorkspaceFileTargets([cwd], '/outside/brief.md', files)).toEqual([{ cwd, path: '/outside/brief.md' }])
  })

  it('uses the longest known root for absolute paths and the current root for relative paths', () => {
    expect(resolveWorkspaceFileTarget(
      ['/Users/example', '/Users/example/project'],
      '/Users/example/project/docs/report.pdf'
    )).toEqual({ cwd: '/Users/example/project', path: 'docs/report.pdf' })
    expect(resolveWorkspaceFileTarget(
      ['/Users/example/current', '/Users/example/other'],
      '/Users/example/other/README.md'
    )).toEqual({ cwd: '/Users/example/other', path: 'README.md' })
    expect(resolveWorkspaceFileTarget(
      ['/Users/example/myNote', '/Users/example/a/much/longer/project/path'],
      '待读清单.md'
    )).toEqual({ cwd: '/Users/example/myNote', path: '待读清单.md' })
  })

  it('passes cross-directory references to main for canonical read-only authorization', () => {
    expect(resolveWorkspaceFileTarget([cwd], '/Users/example/other/secret.txt')).toEqual({ cwd, path: '/Users/example/other/secret.txt' })
    expect(resolveWorkspaceFileTarget([cwd], '../secret.txt')).toEqual({ cwd, path: '../secret.txt' })
    expect(resolveWorkspaceFileTarget([cwd], '@../LICENSE')).toEqual({ cwd, path: '../LICENSE' })
    expect(resolveWorkspaceFileTarget([cwd], '@assets/custom.format')).toEqual({ cwd, path: 'assets/custom.format' })
    expect(resolveWorkspaceFileTarget([cwd], '/Users/example/LICENSE')).toEqual({ cwd, path: '/Users/example/LICENSE' })
  })

  it('rejects remote file URLs, named home users and non-file URL schemes', () => {
    expect(resolveWorkspaceFileReference(cwd, '~someone/Papers/report.md')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, 'file://server/share/report.pdf')).toBeNull()
    for (const reference of ['@https://example.com/data.json', '@javascript:alert(1)', '@data:text/html,test', '@#section']) {
      expect(resolveWorkspaceFileReference(cwd, reference)).toBeNull()
    }
  })

  it('keeps home-relative files clickable through the separately authorized home root', () => {
    expect(resolveWorkspaceFileTarget([cwd], '~/Papers/report.md')).toEqual({
      cwd: '~',
      path: 'Papers/report.md'
    })
    expect(resolveWorkspaceFileTarget([cwd], '@~/Papers/report.md')).toEqual({
      cwd: '~',
      path: 'Papers/report.md'
    })
    expect(resolveWorkspaceFileTarget([cwd], '~/.gitignore')).toEqual({ cwd: '~', path: '.gitignore' })
    expect(resolveWorkspaceFileTarget([cwd], '~/Notes/config')).toEqual({ cwd: '~', path: 'Notes/config' })
    expect(resolveWorkspaceFileTarget([cwd], '~/Papers/folder/')).toEqual({ cwd: '~', path: 'Papers/folder' })
    expect(resolveWorkspaceFileTarget([cwd], '~/')).toEqual({ cwd: '~', path: '.' })
    expect(resolveWorkspaceFileTarget([cwd], `${cwd}/`)).toEqual({ cwd, path: '.' })
  })
})
