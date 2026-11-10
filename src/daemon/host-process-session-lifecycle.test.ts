import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { createAppSessionStore } from '../main/app-store'

afterEach(cleanupTempDirs)

// B4-L4 session lifecycle: the daemon answers rename/pin/archive, the archived list and
// purge, and single deletion with main's own lifecycle. The App asks the user first; the
// daemon deletes only what it was told was confirmed.

describe('daemon session lifecycle', () => {
  it('renames, pins, archives, lists and deletes sessions the App owns', async () => {
    const daemon = await startTestDaemon()
    try {
      const store = createAppSessionStore(daemon.userDataDir)
      for (const id of ['native-a', 'native-b']) {
        store.record({ providerId: 'codex', runtimeProvider: 'codex_cli', externalSessionId: id, cwd: daemon.workspace, prompt: `prompt ${id}` })
      }
      const ref = (externalSessionId: string) => ({ providerId: 'codex', cwd: daemon.workspace, externalSessionId })
      const sessions = () => createAppSessionStore(daemon.userDataDir).load()

      expect((await daemon.localOp('sessionLifecycle', 'renameSession', [ref('native-a'), 'From the App'])).result).toBe(true)
      expect((await daemon.localOp('sessionLifecycle', 'setSessionPinned', [ref('native-a'), true])).result).toBe(true)
      expect(sessions().find((session) => session.externalSessionId === 'native-a')).toMatchObject({ title: 'From the App' })
      expect(sessions().find((session) => session.externalSessionId === 'native-a')?.pinnedAt).toBeTypeOf('number')
      // main's validation, unchanged.
      expect((await daemon.localOp('sessionLifecycle', 'setSessionPinned', [ref('native-a'), 'yes'])).error).toBe('无效的置顶请求')

      expect((await daemon.localOp('sessionLifecycle', 'setSessionArchived', [ref('native-a'), true])).result).toBe(true)
      const archived = (await daemon.localOp('sessionStore', 'listArchivedSessions', [])).result as Array<{ sessions: unknown[] }>
      expect(archived.flatMap((project) => project.sessions)).toHaveLength(1)

      // Purge needs the count the App asked about; a different count deletes nothing.
      expect((await daemon.localOp('sessionPurge', 'deleteArchivedSessions', [])).error).toBe('已存档会话删除未经确认')
      expect((await daemon.localOp('sessionPurge', 'deleteArchivedSessions', [2])).result).toMatchObject({ ok: false, reason: 'catalog_changed', deleted: 0 })
      expect(sessions().some((session) => session.externalSessionId === 'native-a')).toBe(true)
      expect((await daemon.localOp('sessionPurge', 'deleteArchivedSessions', [1])).result).toMatchObject({ ok: true, deleted: 1 })
      expect(sessions().some((session) => session.externalSessionId === 'native-a')).toBe(false)

      // A single deletion; the App hears of it through the event feed.
      const handshake = await daemon.request({ op: 'appEvents', cursor: 0, waitMs: 0 })
      const deleted = await daemon.localOp('sessionLifecycle', 'deleteSession', [ref('native-b')])
      expect(deleted.error).toBeUndefined()
      expect(deleted.result).toMatchObject({ ok: true })
      expect(sessions()).toHaveLength(0)
      const notices = await daemon.request({ op: 'appEvents', epoch: handshake.events.epoch, cursor: handshake.events.cursor, waitMs: 0 })
      expect(notices.events.items).toContainEqual({ kind: 'data', event: expect.objectContaining({ kind: 'session_deleted' }) })
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('deletes a unified conversation the renderer previewed and confirmed', async () => {
    const daemon = await startTestDaemon()
    try {
      // A draft that never sent: no binding, so no Provider context to fence. Deleting one
      // used to fail on that in both modes.
      const created = (await daemon.localOp('conversation', 'create', [daemon.workspace])).result as { id: string; revision: number }
      const archived = await daemon.localOp('conversation', 'update', [created.id, created.revision, { kind: 'archive', archived: true }])
      expect(archived.error).toBeUndefined()
      const previewed = await daemon.localOp('conversation', 'previewDeletion', [created.id])
      expect(previewed.error).toBeUndefined()
      const preview = previewed.result as { fingerprint: string }
      // A fingerprint the user did not see cleans nothing.
      expect((await daemon.localOp('conversation', 'delete', [created.id, 'f'.repeat(64)])).error).toBe('删除范围已变化，请重新预览；本次请求未执行清理')
      const deleted = await daemon.localOp('conversation', 'delete', [created.id, preview.fingerprint])
      expect(deleted.error).toBeUndefined()
      expect(deleted.result).toMatchObject({ ok: true })
      const listed = (await daemon.localOp('conversation', 'list', [daemon.workspace])).result as Array<{ id: string }>
      expect(listed.map((conversation) => conversation.id)).not.toContain(created.id)
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
