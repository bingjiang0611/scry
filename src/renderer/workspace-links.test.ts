import { describe, expect, it } from 'vitest'
import { resolveWorkspaceFileReference, resolveWorkspaceFileTarget } from './workspace-links'

describe('workspace file references', () => {
  const cwd = '/Users/example/project'

  it('resolves absolute, file URL and explicit workspace references inside cwd', () => {
    expect(resolveWorkspaceFileReference(cwd, '/Users/example/project/docs/report.pdf')).toBe('docs/report.pdf')
    expect(resolveWorkspaceFileReference(cwd, 'file:///Users/example/project/docs/report%20one.html')).toBe('docs/report one.html')
    expect(resolveWorkspaceFileReference(cwd, '@"docs/report one.md"')).toBe('docs/report one.md')
    expect(resolveWorkspaceFileReference(cwd, '@src/App.tsx')).toBe('src/App.tsx')
  })

  it('accepts likely relative file paths without turning arbitrary inline code or domains into links', () => {
    expect(resolveWorkspaceFileReference(cwd, 'src/App.tsx')).toBe('src/App.tsx')
    expect(resolveWorkspaceFileReference(cwd, './README.md')).toBe('README.md')
    expect(resolveWorkspaceFileReference(cwd, 'README.md')).toBe('README.md')
    expect(resolveWorkspaceFileReference(cwd, 'package.json')).toBe('package.json')
    expect(resolveWorkspaceFileReference(cwd, 'vite.config.ts')).toBe('vite.config.ts')
    expect(resolveWorkspaceFileReference(cwd, 'Promise<void>')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, 'example.com')).toBeNull()
  })

  it('resolves absolute paths against the longest known workspace root', () => {
    expect(resolveWorkspaceFileTarget(
      ['/Users/example', '/Users/example/project'],
      '/Users/example/project/docs/report.pdf'
    )).toEqual({ cwd: '/Users/example/project', path: 'docs/report.pdf' })
    expect(resolveWorkspaceFileTarget(
      ['/Users/example/current', '/Users/example/other'],
      '/Users/example/other/README.md'
    )).toEqual({ cwd: '/Users/example/other', path: 'README.md' })
  })

  it('rejects paths outside cwd, traversal and remote file URLs', () => {
    expect(resolveWorkspaceFileReference(cwd, '/Users/example/other/secret.txt')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, '/Users/example/project-copy/secret.txt')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, '../secret.txt')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, '@../secret.txt')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, '~/Papers/report.md')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, '@~/Papers/report.md')).toBeNull()
    expect(resolveWorkspaceFileReference(cwd, 'file://server/share/report.pdf')).toBeNull()
  })
})
