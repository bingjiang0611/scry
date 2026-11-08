import { describe, expect, it } from 'vitest'
import type { WorkspaceEntry } from '@shared/workspace'
import { filterWorkspaceTreePaths, normalizeWorkspaceTreeQuery, workspaceTreeAncestors, workspaceTreeEntries } from './workspace-tree'

const file = (path: string): WorkspaceEntry => ({ path, name: path.split('/').at(-1)!, kind: 'file', mtimeMs: 1 })
const directory = (path: string): WorkspaceEntry => ({ path, name: path.split('/').at(-1)!, kind: 'directory', mtimeMs: 1 })
const children = {
  '': [directory('src'), directory('docs'), file('README.md')],
  src: [file('src/file-010.ts'), file('src/file-199.ts'), directory('src/nested')],
  docs: [file('docs/guide.md')]
}

describe('workspace tree projection', () => {
  it('indexes only loaded pages and marks directories with a separator', () => {
    expect([...workspaceTreeEntries(children).keys()]).toEqual([
      'src/', 'src/file-010.ts', 'src/file-199.ts', 'src/nested/', 'docs/', 'docs/guide.md', 'README.md'
    ])
  })

  it('filters case-insensitively on the entry name, directories included', () => {
    const entries = workspaceTreeEntries(children)
    expect(filterWorkspaceTreePaths(entries, '')).toEqual([...entries.keys()])
    expect(filterWorkspaceTreePaths(entries, '   ')).toEqual([...entries.keys()])
    expect(filterWorkspaceTreePaths(entries, '  FILE-01 ')).toEqual(['src/file-010.ts'])
    // The filter matches the entry name only, as the pre-migration tree did; a
    // directory match reveals its loaded children through the expansion list.
    expect(filterWorkspaceTreePaths(entries, 'DOCS')).toEqual(['docs/'])
    expect(filterWorkspaceTreePaths(entries, 'guide')).toEqual(['docs/guide.md'])
    expect(filterWorkspaceTreePaths(entries, 'missing')).toEqual([])
    expect(normalizeWorkspaceTreeQuery(' Docs ')).toBe('docs')
  })

  it('reveals every loaded parent once per matching path and nothing for shallow files', () => {
    expect(workspaceTreeAncestors(['src/file-010.ts', 'src/nested/deep.ts', 'README.md']))
      .toEqual(['src/', 'src/', 'src/nested/'])
    expect(workspaceTreeAncestors([])).toEqual([])
  })
})
