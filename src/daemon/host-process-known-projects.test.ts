import 'reflect-metadata'
import { mkdirSync, realpathSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { createAppSessionStore, createProjectStore } from '../main/app-store'

afterEach(cleanupTempDirs)

// B4-L4 known projects: in daemon mode the App's window selection and its known-project
// file channels ask the daemon whether a directory is one of its projects. The daemon
// answers from its own authority (recent folders, project records, session cwds: the
// same knownProjectDirectories() its runs and source control use), on every call, and
// persists nothing for it.

describe('daemon known projects', () => {
  it('resolves a recent folder by its canonical path and refuses directories it does not know', async () => {
    const daemon = await startTestDaemon()
    try {
      const link = join(daemon.root, 'workspace-link')
      symlinkSync(daemon.workspace, link)
      const resolved = await daemon.localOp('workspaceSelection', 'setCwd', [link])
      expect(resolved.error).toBeUndefined()
      expect(resolved.result).toBe(daemon.workspace)

      const stranger = join(daemon.root, 'stranger')
      mkdirSync(stranger)
      expect((await daemon.localOp('workspaceSelection', 'setCwd', [stranger])).error).toBe('工作目录尚未通过 Scry 目录选择器授权')
      expect((await daemon.localOp('workspaceSelection', 'setCwd', ['relative/dir'])).error).toBe('无效的工作目录')
      const file = join(daemon.root, 'a-file')
      writeFileSync(file, '')
      expect((await daemon.localOp('workspaceSelection', 'setCwd', [file])).error).toBe('工作目录不存在或不是文件夹')
      // Naming no directory clears a selection, as main's handler does; nothing is resolved.
      for (const dir of [null, '', '  ', 42]) {
        const cleared = await daemon.localOp('workspaceSelection', 'setCwd', [dir])
        expect(cleared.error, JSON.stringify(dir)).toBeUndefined()
        expect(cleared.result).toBeNull()
      }
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('knows a session cwd and a project only the daemon recorded, and forgets a removed one at once', async () => {
    const daemon = await startTestDaemon()
    try {
      // Only in the daemon's session catalog: not a recent folder, not a project record.
      const sessionOnly = join(daemon.root, 'session-only')
      mkdirSync(sessionOnly)
      createAppSessionStore(daemon.userDataDir).record({
        providerId: 'codex', runtimeProvider: 'codex_cli', externalSessionId: 'native-a', cwd: realpathSync(sessionOnly), prompt: 'p'
      })
      expect((await daemon.localOp('workspaceSelection', 'setCwd', [sessionOnly])).result).toBe(realpathSync(sessionOnly))

      // Chosen after the daemon started: known on the next call, no stale copy.
      const chosen = join(daemon.root, 'chosen')
      mkdirSync(chosen)
      expect((await daemon.localOp('workspaceSelection', 'setCwd', [chosen])).error).toBe('工作目录尚未通过 Scry 目录选择器授权')
      expect((await daemon.localOp('workspaceSelection', 'chooseFolder', [chosen])).result).toBe(realpathSync(chosen))
      expect((await daemon.localOp('workspaceSelection', 'setCwd', [chosen])).result).toBe(realpathSync(chosen))

      // Removing the project (and its recent folder) withdraws it on the next call.
      expect((await daemon.localOp('projectStore', 'removeProject', [realpathSync(chosen)])).result).toBe(true)
      expect((await daemon.localOp('workspaceSelection', 'setCwd', [chosen])).error).toBe('工作目录尚未通过 Scry 目录选择器授权')
      expect(createProjectStore(daemon.userDataDir).load().find((project) => project.cwd === realpathSync(chosen))?.removedAt).toBeTypeOf('number')
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('persists nothing when it validates a selection', async () => {
    const daemon = await startTestDaemon()
    try {
      const files = ['recent-folders.json', 'projects.json', 'app-sessions.json']
      const snapshot = () => files.map((name) => { try { return readFileSync(join(daemon.userDataDir, name), 'utf8') } catch { return null } })
      const before = snapshot()
      expect((await daemon.localOp('workspaceSelection', 'setCwd', [daemon.workspace])).result).toBe(daemon.workspace)
      expect(snapshot()).toEqual(before)
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('is a local-only op: the network endpoint does not serve it', async () => {
    const { DAEMON_LOCAL_OP_CHANNELS, DAEMON_LOCAL_OP_NAMES } = await import('../main/daemon-channel-gate')
    expect(DAEMON_LOCAL_OP_CHANNELS['agent:setCwd']).toEqual({ op: 'workspaceSelection', method: 'setCwd', read: true })
    expect(DAEMON_LOCAL_OP_NAMES.has('workspaceSelection')).toBe(true)
  })
})
