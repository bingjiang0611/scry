import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appSessionCanResume,
  cleanupAppStoreAtomicTemps,
  createAppSessionStore,
  createProjectStore,
  createRecentFoldersStore,
  mergeProjectMetas
} from './app-store'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-store-'))

describe('app-store', () => {
  it('removes strictly named crash-temp catalog copies only during single-instance startup cleanup', () => {
    const dir = tempDir()
    try {
      const crashTemp = join(dir, 'app-sessions.json.123.00000000-0000-4000-8000-000000000000.tmp')
      writeFileSync(crashTemp, 'sensitive stale snapshot')
      createAppSessionStore(dir)
      expect(existsSync(crashTemp)).toBe(true)
      cleanupAppStoreAtomicTemps(dir)
      expect(existsSync(crashTemp)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not treat a runId-backed failure archive as a Provider resume id', () => {
    expect(appSessionCanResume({ runId: 'run-1', externalSessionId: 'run-1' })).toBe(false)
    expect(appSessionCanResume({ runId: 'run-1', externalSessionId: 'native-1' })).toBe(true)
  })

  it('recent folders 去重并保留最近 8 个', () => {
    const dir = tempDir()
    try {
      const store = createRecentFoldersStore(dir)
      for (let i = 0; i < 10; i++) store.push(`/repo-${i}`)
      store.push('/repo-3')
      expect(store.load()).toEqual(['/repo-3', '/repo-9', '/repo-8', '/repo-7', '/repo-6', '/repo-5', '/repo-4', '/repo-2'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recent folders 可以只移除历史记录', () => {
    const dir = tempDir()
    try {
      const store = createRecentFoldersStore(dir)
      store.push('/repo-a')
      store.push('/repo-b')
      expect(store.remove('/repo-a')).toEqual(['/repo-b'])
      expect(store.load()).toEqual(['/repo-b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('项目目录独立于会话保留，并支持置顶、重命名、移除和重新打开', () => {
    const dir = tempDir()
    try {
      const store = createProjectStore(dir)
      store.seed([
        { cwd: '/repo/empty', lastOpenedAt: 1 },
        { cwd: '/repo/empty', lastOpenedAt: 2 },
        { cwd: '/repo/full', lastOpenedAt: 3 }
      ])
      expect(store.load()).toHaveLength(2)
      expect(store.rename('/repo/empty', '空项目')).toBe(true)
      expect(store.setPinned('/repo/empty', true)).toBe(true)

      const withEmpty = mergeProjectMetas(store.load(), [{
        cwd: '/repo/full', name: 'full', mtime: 4, sessions: []
      }])
      expect(withEmpty.map((project) => project.cwd)).toEqual(['/repo/empty', '/repo/full'])
      expect(withEmpty[0]).toMatchObject({ name: '空项目', sessions: [], pinnedAt: expect.any(Number) })

      store.remove('/repo/empty')
      expect(mergeProjectMetas(store.load(), []).map((project) => project.cwd)).toEqual(['/repo/full'])
      store.remember('/repo/empty')
      expect(mergeProjectMetas(store.load(), [])[0]).toMatchObject({ cwd: '/repo/empty', name: '空项目' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('项目合并时保留 Chats 在末尾，并让项目级置顶优先', () => {
    const projects = mergeProjectMetas(
      [
        { cwd: '/repo/pinned', lastOpenedAt: 1, pinnedAt: 10 },
        { cwd: '/repo/empty', lastOpenedAt: 8 }
      ],
      [
        { cwd: '/repo/session', name: 'session', mtime: 20, sessions: [] },
        { cwd: '', name: 'Chats', mtime: 30, sessions: [] }
      ]
    )
    expect(projects.map((project) => project.cwd)).toEqual(['/repo/pinned', '/repo/session', '/repo/empty', ''])
  })

  it('app sessions 只按 app 自己记录的 cwd 分组', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.record({ providerId: 'claude', runtimeProvider: 'claude_sdk', externalSessionId: 's1', cwd: '/repo/a', prompt: 'first prompt' })
      store.record({ providerId: 'codex', runtimeProvider: 'codex_cli', externalSessionId: 's2', cwd: '/repo/b', prompt: 'second prompt' })
      store.record({ providerId: 'claude', runtimeProvider: 'claude_sdk', externalSessionId: 's1', cwd: '/repo/a', prompt: 'resume prompt' })

      expect(store.listSessions('/repo/a', 'claude')).toEqual([
        {
          sessionId: 's1',
          externalSessionId: 's1',
          providerId: 'claude',
          runtimeProvider: 'claude_sdk',
          mtime: expect.any(Number),
          preview: 'first prompt',
          count: 1
        }
      ])
      expect(store.listProjects().map((p) => p.cwd).sort()).toEqual(['/repo/a', '/repo/b'])

      store.remove({ providerId: 'claude', cwd: '/repo/a', externalSessionId: 's1' })
      expect(store.listSessions('/repo/a')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('首轮标题在 pending 晋升、多轮续聊及重新加载后保持不变，仍更新 run 身份与活跃时间', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      const prompt = '首轮任务'.repeat(30)
      const request = { providerId: 'pi' as const, runtimeProvider: 'pi_rpc' as const, cwd: '/repo', runId: 'run-1', prompt }
      store.recordPending(request)
      store.recordPending({ ...request, prompt: '重复通知' })
      store.record({ ...request, externalSessionId: 'native-1', prompt: '身份晋升' })
      expect(store.listSessions('/repo')[0].preview).toBe(prompt.slice(0, 80))
      store.save(store.load().map((session) => ({ ...session, ts: 1 })))
      for (const runId of ['run-2', 'run-3']) {
        store.record({ ...request, runId, externalSessionId: 'native-1', prompt: '继续' })
      }
      const sessions = createAppSessionStore(dir).listSessions('/repo')
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ preview: prompt.slice(0, 80), runId: 'run-3', externalSessionId: 'native-1' })
      expect(sessions[0].mtime).toBeGreaterThan(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('不绑定项目的会话也进入 catalog，并以独立分组展示', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.recordPending({
        providerId: 'qoder',
        runtimeProvider: 'qoder_cli',
        runId: 'run-unbound',
        cwd: '',
        prompt: 'unbound task'
      })
      store.record({
        providerId: 'qoder',
        runtimeProvider: 'qoder_cli',
        runId: 'run-unbound',
        externalSessionId: 'session-unbound',
        cwd: '',
        prompt: 'unbound task'
      })

      expect(store.listProjects()).toEqual([
        expect.objectContaining({
          cwd: '',
          name: 'Chats',
          sessions: [expect.objectContaining({
            sessionId: 'session-unbound',
            externalSessionId: 'session-unbound',
            providerId: 'qoder'
          })]
        })
      ])
      expect(store.listSessions('', 'qoder')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Chats 分组优先级最低，即使最近活跃也排在真实项目之后', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.record({
        providerId: 'claude',
        runtimeProvider: 'claude_sdk',
        externalSessionId: 'bound',
        cwd: '/repo/a',
        prompt: 'older bound task'
      })
      store.record({
        providerId: 'qoder',
        runtimeProvider: 'qoder_cli',
        externalSessionId: 'unbound',
        cwd: '',
        prompt: 'newest unbound task'
      })

      const projects = store.listProjects()
      expect(projects.map((p) => p.cwd)).toEqual(['/repo/a', ''])
      // 不绑定分组确实更新，依然被排到末尾
      expect(projects.at(-1)!.mtime).toBeGreaterThanOrEqual(projects[0].mtime)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('合并已存在 Provider 会话与旧版远程续聊留下的 pending 重复项', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.record({
        providerId: 'qoder', runtimeProvider: 'qoder_cli', externalSessionId: 'session-1',
        cwd: '/repo', prompt: 'old prompt'
      })
      store.recordPending({
        providerId: 'qoder', runtimeProvider: 'qoder_cli', runId: 'remote-run-1',
        cwd: '/repo', prompt: 'mobile follow-up'
      })
      expect(store.listSessions('/repo', 'qoder')).toHaveLength(2)

      store.record({
        providerId: 'qoder', runtimeProvider: 'qoder_cli', runId: 'remote-run-1',
        externalSessionId: 'session-1', cwd: '/repo', prompt: 'mobile follow-up'
      })

      const sessions = store.listSessions('/repo', 'qoder')
      expect(sessions).toEqual([
        expect.objectContaining({
          sessionId: 'session-1', externalSessionId: 'session-1', runId: 'remote-run-1',
          preview: 'old prompt'
        })
      ])
      expect(sessions[0]).not.toHaveProperty('pending')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('隔离相同 external session id，并把无证据老数据标成 legacy_unknown', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.record({ providerId: 'codex', runtimeProvider: 'codex_cli', externalSessionId: 'same', cwd: '/repo', prompt: 'codex' })
      store.record({ providerId: 'qoder', runtimeProvider: 'qoder_cli', externalSessionId: 'same', cwd: '/repo', prompt: 'qoder' })
      expect(store.listSessions('/repo').map((session) => session.providerId).sort()).toEqual(['codex', 'qoder'])

      store.save([{ sessionId: 'legacy', cwd: '/repo', preview: 'old', ts: 1 }])
      expect(store.load()[0]).toMatchObject({ externalSessionId: 'legacy', providerId: 'legacy_unknown' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('先用 runId 立即展示启动中会话，拿到原生 sessionId 后原位升级且不重复', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.recordPending({
        providerId: 'claude',
        runtimeProvider: 'claude_sdk',
        runId: 'run-1',
        cwd: '/repo',
        prompt: 'inspect hooks'
      })

      expect(store.listProjects()[0].sessions).toEqual([
        expect.objectContaining({
          sessionId: 'run-1',
          runId: 'run-1',
          pending: true,
          preview: 'inspect hooks'
        })
      ])

      store.record({
        providerId: 'claude',
        runtimeProvider: 'claude_sdk',
        runId: 'run-1',
        externalSessionId: 'session-1',
        cwd: '/repo',
        prompt: 'inspect hooks'
      })

      expect(store.listProjects()[0].sessions).toEqual([
        expect.objectContaining({
          sessionId: 'session-1',
          runId: 'run-1',
          externalSessionId: 'session-1'
        })
      ])

      store.record({
        providerId: 'claude',
        runtimeProvider: 'claude_sdk',
        runId: 'run-2',
        externalSessionId: 'session-1',
        cwd: '/repo',
        prompt: 'continue'
      })

      expect(store.listProjects()[0].sessions).toEqual([
        expect.objectContaining({
          sessionId: 'session-1',
          runId: 'run-2',
          externalSessionId: 'session-1'
        })
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('主 catalog 损坏时回读 last-known-good backup 并暴露 degraded', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.save([{ sessionId: 'old', cwd: '/repo', preview: 'old', ts: 1 }])
      store.save([{ sessionId: 'new', cwd: '/repo', preview: 'new', ts: 2 }])
      writeFileSync(join(dir, 'app-sessions.json'), '{partial')
      expect(store.load()).toEqual([expect.objectContaining({ sessionId: 'old' })])
      expect(store.health()).toMatchObject({ status: 'degraded', source: 'backup' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('主 catalog 虽可解析但 schema 错误时回读 backup，而不是伪装 ready', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.save([{ sessionId: 'backup', cwd: '/repo', preview: 'old', ts: 1 }])
      store.save([{ sessionId: 'primary', cwd: '/repo', preview: 'new', ts: 2 }])
      writeFileSync(join(dir, 'app-sessions.json'), JSON.stringify([null]))
      expect(store.load()).toEqual([expect.objectContaining({ sessionId: 'backup' })])
      expect(store.health()).toMatchObject({ status: 'degraded', source: 'backup' })

      writeFileSync(join(dir, 'app-sessions.json'), JSON.stringify([{
        sessionId: {},
        runId: 'looks-valid',
        cwd: '/repo',
        preview: 'bad identity type',
        ts: 3
      }]))
      expect(store.load()).toEqual([expect.objectContaining({ sessionId: 'backup' })])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('主 catalog 和 backup 都损坏时显式失败而不是返回空目录', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      writeFileSync(join(dir, 'app-sessions.json'), '{partial')
      writeFileSync(join(dir, 'app-sessions.json.bak'), '{also-partial')
      expect(() => store.listProjects()).toThrow('均不可用')
      expect(store.health()).toMatchObject({ status: 'unavailable' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('删除会话同时更新 primary 与 backup，fallback 不会复活已删项', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.record({ providerId: 'codex', runtimeProvider: 'codex_cli', externalSessionId: 'session-1', cwd: '/repo', prompt: 'hello' })
      store.remove({ providerId: 'codex', cwd: '/repo', externalSessionId: 'session-1' })
      writeFileSync(join(dir, 'app-sessions.json'), '{broken')
      expect(store.listSessions('/repo', 'codex')).toEqual([])
      expect(store.health()).toMatchObject({ status: 'degraded', source: 'backup' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('重命名持久保存，后续发送、置顶、存档及重启不覆盖手动名称或原始预览', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      const request = { providerId: 'qoder' as const, runtimeProvider: 'qoder_cli' as const, externalSessionId: 's1', cwd: '/repo', prompt: 'first' }
      store.record(request)
      const before = store.load()[0].ts
      expect(store.rename(request, '  我的会话  ')).toBe(true)
      expect(store.load()[0]).toMatchObject({ title: '我的会话', preview: 'first', ts: before })
      store.record({ ...request, prompt: 'next message' })
      store.setPinned(request, true)
      expect(store.listProjects()[0].sessions[0].preview).toBe('我的会话')
      store.setArchived(request, true)
      expect(createAppSessionStore(dir).listArchivedProjects()[0].sessions[0].preview).toBe('我的会话')
      store.setArchived(request, false)
      expect(createAppSessionStore(dir).listSessions('/repo')[0].preview).toBe('我的会话')
      expect(store.load()[0].preview).toBe('first')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('重命名严格按 provider/profile/cwd/session 定位，支持 pending 身份晋升', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      const request = { providerId: 'pi' as const, runtimeProvider: 'pi_rpc' as const, agentProfileId: 'pi-a', cwd: '/repo', runId: 'run-1', prompt: 'hello' }
      store.recordPending(request)
      const ref = { ...request, externalSessionId: 'run-1' }
      for (const wrong of [{ providerId: 'qoder' as const }, { agentProfileId: 'pi-b' }, { cwd: '/else' }, { externalSessionId: 'missing' }]) {
        expect(store.rename({ ...ref, ...wrong }, 'wrong')).toBe(false)
      }
      for (const invalid of ['', '  ', 'a'.repeat(121), 'a\nb', 42, null]) {
        expect(() => store.rename(ref, invalid)).toThrow()
      }
      expect(store.rename(ref, '待建立会话')).toBe(true)
      store.record({ ...request, externalSessionId: 'native-1', prompt: 'response' })
      expect(store.listSessions('/repo', 'pi', 'pi-a')[0]).toMatchObject({ sessionId: 'native-1', preview: '待建立会话' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('置顶只标记会话，不影响它留在原项目分组里', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.record({ providerId: 'codex', runtimeProvider: 'codex_cli', externalSessionId: 's1', cwd: '/repo/a', prompt: 'pin me' })
      const ref = { providerId: 'codex' as const, cwd: '/repo/a', externalSessionId: 's1' }

      expect(store.setPinned(ref, true)).toBe(true)
      expect(store.listProjects()[0].sessions[0].pinnedAt).toEqual(expect.any(Number))
      expect(store.listArchivedProjects()).toEqual([])

      expect(store.setPinned(ref, false)).toBe(true)
      expect(store.listProjects()[0].sessions[0].pinnedAt).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('存档把会话移出 listProjects 并清掉置顶，取消存档能放回原项目', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.record({ providerId: 'claude', runtimeProvider: 'claude_sdk', externalSessionId: 's1', cwd: '/repo/a', prompt: 'archive me' })
      store.record({ providerId: 'claude', runtimeProvider: 'claude_sdk', externalSessionId: 's2', cwd: '/repo/a', prompt: 'keep me' })
      const ref = { providerId: 'claude' as const, cwd: '/repo/a', externalSessionId: 's1' }
      store.setPinned(ref, true)

      expect(store.setArchived(ref, true)).toBe(true)
      expect(store.listProjects()[0].sessions.map((s) => s.sessionId)).toEqual(['s2'])
      const archived = store.listArchivedProjects()
      expect(archived).toHaveLength(1)
      expect(archived[0].sessions[0]).toMatchObject({ sessionId: 's1', archivedAt: expect.any(Number) })
      // 已存档会话不出现在侧边栏，置顶标记一并清掉。
      expect(archived[0].sessions[0].pinnedAt).toBeUndefined()

      expect(store.setArchived(ref, false)).toBe(true)
      expect(store.listProjects()[0].sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
      expect(store.listArchivedProjects()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('定位不到会话时置顶与存档如实返回 false，不写入空记录', () => {
    const dir = tempDir()
    try {
      const store = createAppSessionStore(dir)
      store.record({ providerId: 'codex', runtimeProvider: 'codex_cli', externalSessionId: 's1', cwd: '/repo/a', prompt: 'only session' })
      const missing = { providerId: 'codex' as const, cwd: '/repo/a', externalSessionId: 'nope' }

      expect(store.setPinned(missing, true)).toBe(false)
      expect(store.setArchived(missing, true)).toBe(false)
      expect(store.load()).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('老索引没有 pinnedAt / archivedAt 仍是健康 catalog，不降级到备份', () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'app-sessions.json'), JSON.stringify([
        { sessionId: 's1', externalSessionId: 's1', providerId: 'codex', cwd: '/repo/a', preview: 'legacy', ts: 1 }
      ]))
      const store = createAppSessionStore(dir)

      expect(store.listProjects()[0].sessions[0]).toMatchObject({ sessionId: 's1', preview: 'legacy' })
      expect(store.listProjects()[0].sessions[0].pinnedAt).toBeUndefined()
      expect(store.listArchivedProjects()).toEqual([])
      expect(store.health()).toMatchObject({ status: 'ready', source: 'primary' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pinnedAt 不是有限数字时按损坏索引处理，不静默当成已置顶', () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'app-sessions.json'), JSON.stringify([
        { sessionId: 's1', externalSessionId: 's1', providerId: 'codex', cwd: '/repo/a', preview: 'broken', ts: 1, pinnedAt: 'soon' }
      ]))
      const store = createAppSessionStore(dir)

      expect(() => store.listProjects()).toThrow('均不可用')
      expect(store.health()).toMatchObject({ status: 'unavailable' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
