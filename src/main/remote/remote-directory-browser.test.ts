import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalExistingDirectory } from '../workspace-authorization'
import { canonicalRemoteProjectRoots, listRemoteDirectories, resolveRemoteProjectDirectory } from './remote-directory-browser'

describe('remote directory browser', () => {
  it('lists authorized roots and navigates descendants without escaping the grant', () => {
    const base = mkdtempSync(join(tmpdir(), 'scry-remote-folders-'))
    const root = join(base, 'project')
    const sibling = join(base, 'outside')
    const source = join(root, 'src')
    const nested = join(source, 'main')
    try {
      mkdirSync(nested, { recursive: true })
      mkdirSync(join(root, '..cache'))
      mkdirSync(join(root, 'apps'))
      mkdirSync(sibling)
      symlinkSync(sibling, join(root, 'outside-link'))

      const canonicalRoot = canonicalExistingDirectory(root)
      expect(canonicalRemoteProjectRoots([root, root, join(base, 'missing')])).toEqual([canonicalRoot])
      expect(listRemoteDirectories(undefined, [root])).toEqual({
        directories: [{ path: canonicalRoot, label: 'project' }]
      })
      expect(listRemoteDirectories(root, [root])).toEqual({
        current: { path: canonicalRoot, label: 'project' },
        directories: [
          { path: canonicalExistingDirectory(join(root, '..cache')), label: '..cache' },
          { path: canonicalExistingDirectory(join(root, 'apps')), label: 'apps' },
          { path: canonicalExistingDirectory(source), label: 'src' }
        ]
      })
      expect(listRemoteDirectories(source, [root])).toEqual({
        current: { path: canonicalExistingDirectory(source), label: 'src' },
        parent: { path: canonicalRoot, label: 'project' },
        directories: [{ path: canonicalExistingDirectory(nested), label: 'main' }]
      })
      expect(resolveRemoteProjectDirectory(nested, [root])).toBe(canonicalExistingDirectory(nested))
      expect(() => resolveRemoteProjectDirectory(sibling, [root])).toThrow('不在')
      expect(() => listRemoteDirectories(sibling, [root])).toThrow('workspace_not_authorized')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
