import { describe, expect, it } from 'vitest'
import { resolveWorkspaceFileReference, resolveWorkspaceFileTarget, resolveWorkspaceFileTargets } from './workspace-links'

describe('workspace file references', () => {
  const cwd = '/Users/example/project'

  it('resolves absolute, file URL and explicit workspace references inside cwd', () => {
    expect(resolveWorkspaceFileReference(cwd, '/Users/example/project/docs/report.pdf')).toBe('docs/report.pdf')
    expect(resolveWorkspaceFileReference(cwd, 'file:///Users/example/project/docs/report%20one.html')).toBe('docs/report one.html')
    expect(resolveWorkspaceFileReference(cwd, '@"docs/report one.md"')).toBe('docs/report one.md')
    expect(resolveWorkspaceFileReference(cwd, '@src/App.tsx')).toBe('src/App.tsx')
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
