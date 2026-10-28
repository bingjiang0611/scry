import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAppSessionStore, createProjectStore, mergeProjectMetas } from './app-store'

describe('worktree session catalog grouping', () => {
  it('groups by the source project while retaining the execution cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-worktree-store-'))
    try {
      const store = createAppSessionStore(dir)
      store.recordPending({
        providerId: 'pi', runtimeProvider: 'pi_rpc', runId: 'run-worktree',
        cwd: '/data/worktrees/random-id', projectCwd: '/repo/scry', prompt: 'worktree task'
      })
      store.record({
        providerId: 'pi', runtimeProvider: 'pi_rpc', runId: 'run-worktree', externalSessionId: 'native-worktree',
        cwd: '/data/worktrees/random-id', prompt: 'worktree task'
      })

      expect(store.listProjects()).toEqual([
        expect.objectContaining({
          cwd: '/repo/scry',
          sessions: [expect.objectContaining({
            sessionId: 'native-worktree',
            cwd: '/data/worktrees/random-id'
          })]
        })
      ])
      expect(store.listSessions('/data/worktrees/random-id', 'pi')).toHaveLength(1)
      expect(store.listProjects().some(project => project.cwd === '/data/worktrees/random-id')).toBe(false)
      expect(store.setArchived({
        providerId: 'pi', cwd: '/data/worktrees/random-id', externalSessionId: 'native-worktree'
      }, true)).toBe(true)
      expect(store.listArchivedProjects()[0]).toMatchObject({
        cwd: '/repo/scry', sessions: [expect.objectContaining({ cwd: '/data/worktrees/random-id' })]
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never lists a Scry-managed worktree as a project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-worktree-project-'))
    try {
      const worktree = join(dir, 'worktrees', 'repo-hash', 'session-uuid')
      mkdirSync(worktree, { recursive: true })
      // 旧版本会把执行 worktree 记成项目根；读时不能再把它当项目。
      writeFileSync(join(dir, 'projects.json'), JSON.stringify([{ cwd: worktree, lastOpenedAt: 1 }]))
      const store = createProjectStore(dir)
      expect(store.load()).toEqual([])
      expect(mergeProjectMetas(store.load(), [])).toEqual([])

      // 正常项目不能被同一条规则误伤。
      store.remember(join(dir, 'repo'))
      expect(store.load().map((project) => project.cwd)).toEqual([join(dir, 'repo')])
      store.seed([{ cwd: worktree, lastOpenedAt: 2 }])
      expect(store.load().map((project) => project.cwd)).toEqual([join(dir, 'repo')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
