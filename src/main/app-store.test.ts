import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAppSessionStore, createRecentFoldersStore } from './app-store'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-store-'))

describe('app-store', () => {
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
})
