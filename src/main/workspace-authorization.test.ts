import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { authorizedWorkspaceRequest, canonicalExistingDirectory, knownProjectDirectory } from './workspace-authorization'

describe('workspace authorization', () => {
  it('accepts only canonical directories previously selected by main', () => {
    const root = mkdtempSync(join(tmpdir(), 'scry-workspace-auth-'))
    const selected = join(root, 'selected')
    const other = join(root, 'other')
    const alias = join(root, 'alias')
    try {
      mkdirSync(selected)
      mkdirSync(other)
      symlinkSync(selected, alias)
      expect(knownProjectDirectory(alias, [selected])).toBe(canonicalExistingDirectory(selected))
      expect(() => knownProjectDirectory(other, [selected])).toThrow('尚未')
      expect(authorizedWorkspaceRequest(selected, { cwd: alias, path: 'README.md' })).toEqual({
        cwd: canonicalExistingDirectory(selected),
        path: 'README.md'
      })
      expect(() => authorizedWorkspaceRequest(selected, { cwd: other, path: 'README.md' })).toThrow('不一致')
      expect(() => authorizedWorkspaceRequest(undefined, { cwd: selected, path: '' })).toThrow('未授权')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
