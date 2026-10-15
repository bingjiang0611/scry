import { describe, expect, it } from 'vitest'
import type { ScRepository } from '@shared/source-control'
import { commitBlocker, commitFiles, nextGitAction } from './source-control-workflow'

const repo: ScRepository = {
  id: 'repo', root: '/repo', branch: 'feature', head: 'head', revision: 'revision', observedAt: 1,
  upstream: 'origin/feature', ahead: 1, behind: 0, remotes: [], writeBlocker: null, actionBlockers: {},
  files: [
    { path: 'partial.ts', index: 'M', worktree: 'M', untracked: false, conflict: false },
    { path: 'chosen.ts', index: '.', worktree: 'M', untracked: false, conflict: false },
    { path: 'notes.md', index: '.', worktree: '?', untracked: true, conflict: false }
  ]
}

describe('guided Git workflow presentation', () => {
  it('keeps the complete existing index and adds only selected workspace paths', () => {
    expect(commitFiles(repo, ['chosen.ts']).map((file) => file.path)).toEqual(['partial.ts', 'chosen.ts'])
    expect(commitFiles(repo, []).map((file) => file.path)).toEqual(['partial.ts'])
    expect(commitFiles(repo, ['not-in-snapshot']).map((file) => file.path)).toEqual(['partial.ts'])
  })

  it('opens range selection even when the index is empty, instead of disabling the entry', () => {
    expect(nextGitAction({ ...repo, files: repo.files.slice(1) }, null, false).action).toBe('commit')
  })

  it('offers push after a confirmed commit even with other WIP remaining', () => {
    const delivery = { repositoryId: repo.id, branch: repo.branch, head: repo.head!, next: 'push' as const }
    expect(nextGitAction(repo, delivery, false).action).toBe('push')
    expect(nextGitAction({ ...repo, head: 'another' }, delivery, false).action).toBe('commit')
    expect(nextGitAction({ ...repo, branch: 'another' }, delivery, false).action).toBe('commit')
    expect(nextGitAction({ ...repo, id: 'another' }, delivery, false).action).toBe('commit')
  })

  it('never upgrades tracking-reference counts into confirmed remote success', () => {
    expect(nextGitAction(repo, null, false).action).toBe('commit')
    expect(nextGitAction(repo, { repositoryId: repo.id, branch: repo.branch, head: repo.head!, next: 'pr' }, false).action).toBe('pr')
    expect(nextGitAction(repo, null, true).action).toBe('operations')
  })

  it('checks stage and commit blockers separately, not pre-push for a local commit', () => {
    expect(commitBlocker({ ...repo, actionBlockers: { push: 'pre-push' } }, ['chosen.ts'])).toBeNull()
    expect(commitBlocker({ ...repo, actionBlockers: { stage: 'post-index-change' } }, ['chosen.ts'])).toBe('post-index-change')
    expect(commitBlocker({ ...repo, actionBlockers: { stage: 'post-index-change' } }, [])).toBeNull()
    expect(commitBlocker({ ...repo, actionBlockers: { commit: 'pre-commit' } }, [])).toBe('pre-commit')
    expect(commitBlocker({ ...repo, writeBlocker: 'unknown' }, [])).toBe('unknown')
  })
})
