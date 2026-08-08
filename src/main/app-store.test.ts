import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appSessionCanResume, cleanupAppStoreAtomicTemps, createAppSessionStore, createRecentFoldersStore } from './app-store'

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
})
