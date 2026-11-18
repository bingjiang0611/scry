import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { startTestDaemon, type TestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

// The App's workbench channels forward to the `desktopWorkbench` op the daemon's host
// already serves paired devices (B4-L4). These run against a real daemon on the App's
// local socket and grant: the daemon owns the workspace authorization, the App only
// builds the request.

function workbench(daemon: TestDaemon, query: Record<string, unknown>): Promise<Record<string, any>> {
  return daemon.request({ op: 'desktopWorkbench', query })
}

describe('daemon workbench for the App', () => {
  it('reads and writes a file in an authorized workspace', async () => {
    const daemon = await startTestDaemon()
    try {
      writeFileSync(join(daemon.workspace, 'notes.txt'), 'first\n')
      const cwd = daemon.workspace
      const listed = await workbench(daemon, { surface: 'workspace', cwd, method: 'workspaceList', args: [{ cwd, path: '' }] })
      expect(listed.error).toBeUndefined()
      expect(listed.workbench.entries.map((entry: { name: string }) => entry.name)).toContain('notes.txt')

      const read = await workbench(daemon, { surface: 'workspace', cwd, method: 'workspaceRead', args: [{ cwd, path: 'notes.txt' }] })
      expect(read.error).toBeUndefined()
      expect(read.workbench.content).toBe('first\n')

      const written = await workbench(daemon, {
        surface: 'workspace', cwd, method: 'workspaceWrite',
        args: [{ cwd, path: 'notes.txt', content: 'second\n', expectedRevision: read.workbench.revision }]
      })
      expect(written.error).toBeUndefined()
      expect(written.workbench.content).toBe('second\n')
      expect(readFileSync(join(daemon.workspace, 'notes.txt'), 'utf8')).toBe('second\n')

      // A write against a stale revision is refused, not merged over the newer content.
      const stale = await workbench(daemon, {
        surface: 'workspace', cwd, method: 'workspaceWrite',
        args: [{ cwd, path: 'notes.txt', content: 'third\n', expectedRevision: read.workbench.revision }]
      })
      expect(stale.error).toBeTruthy()
      expect(readFileSync(join(daemon.workspace, 'notes.txt'), 'utf8')).toBe('second\n')
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('refuses a workspace the daemon never authorized, and a path that leaves the workspace', async () => {
    const daemon = await startTestDaemon()
    try {
      const outside = realpathSync(tempDir())
      writeFileSync(join(outside, 'secret.txt'), 'not yours\n')
      const unknown = await workbench(daemon, {
        surface: 'workspace', cwd: outside, method: 'workspaceRead', args: [{ cwd: outside, path: 'secret.txt' }]
      })
      expect(unknown.error).toBeTruthy()
      expect(unknown).not.toHaveProperty('workbench')

      // The window's workspace is authorized; the request inside it names another one.
      const cwd = daemon.workspace
      const mismatch = await workbench(daemon, {
        surface: 'workspace', cwd, method: 'workspaceWrite',
        args: [{ cwd: outside, path: 'secret.txt', content: 'overwritten', expectedRevision: 'x' }]
      })
      expect(mismatch.error).toBeTruthy()
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('not yours\n')

      const escape = await workbench(daemon, {
        surface: 'workspace', cwd, method: 'workspaceCreate',
        args: [{ cwd, parentPath: '..', name: 'escaped.txt', kind: 'file' }]
      })
      expect(escape.error).toBeTruthy()
      expect(existsSync(join(daemon.root, 'escaped.txt'))).toBe(false)
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('binds source control to the repository read in that workspace', async () => {
    const daemon = await startTestDaemon()
    try {
      const cwd = daemon.workspace
      execFileSync('git', ['init', '-q', cwd])
      writeFileSync(join(cwd, 'tracked.txt'), 'hello\n')
      const read = await workbench(daemon, { surface: 'sourceControl', cwd, method: 'read', args: [cwd] })
      expect(read.error).toBeUndefined()
      expect(read.workbench.status).toBe('available')
      const repositoryId = read.workbench.data.id as string
      expect(read.workbench.data.files.map((file: { path: string }) => file.path)).toContain('tracked.txt')

      const operations = await workbench(daemon, { surface: 'sourceControl', cwd, method: 'operations', args: [{ repositoryId }] })
      expect(operations.error).toBeUndefined()
      expect(operations.workbench).toEqual([])
      const draft = await workbench(daemon, { surface: 'sourceControl', cwd, method: 'loadCommitDraft', args: [{ repositoryId }] })
      expect(draft.error).toBeUndefined()
      expect(draft.workbench).toBeNull()

      // A repository id is a reference, not a grant: another authorized directory that is
      // not that repository does not reach it.
      const other = join(cwd, 'nested')
      mkdirSync(other)
      execFileSync('git', ['init', '-q', other])
      const crossed = await workbench(daemon, { surface: 'sourceControl', cwd: other, method: 'operations', args: [{ repositoryId }] })
      expect(crossed.error).toBe('repository_context_mismatch')
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('keeps the shell operations it cannot perform a named absence', async () => {
    const daemon = await startTestDaemon()
    try {
      const cwd = daemon.workspace
      writeFileSync(join(cwd, 'keep.txt'), 'keep\n')
      const info = await daemon.request({ op: 'desktop', query: { kind: 'info' } })
      expect(info.desktop.workbench).toBe(1)
      expect(info.desktop.workbenchOps).toEqual({ openPath: false, trashItem: false })
      const trashed = await workbench(daemon, { surface: 'workspace', cwd, method: 'workspaceTrash', args: [{ cwd, path: 'keep.txt' }] })
      expect(trashed.error).toBe('desktop_workbench_operation_unavailable:trashItem')
      expect(existsSync(join(cwd, 'keep.txt'))).toBe(true)
      const opened = await workbench(daemon, { surface: 'workspace', cwd, method: 'workspaceOpenExternal', args: [{ cwd, path: 'keep.txt' }] })
      expect(opened.error).toBe('desktop_workbench_operation_unavailable:openPath')
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})
