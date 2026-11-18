import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { createProjectStore, createRecentFoldersStore } from '../main/app-store'
import { createPiAgentProfileStore, piProfileForExecutable } from '../main/pi-agent-profiles'
import { createWorkspaceRuntime } from '../main/bootstrap/workspace-runtime'

afterEach(cleanupTempDirs)

// B4-L4 project and workspace selection: the daemon writes the project list and the
// recent folders (its own workspace authorization input), validates and remembers the
// folder the App's picker chose, answers worktree selection from its source-control
// service, and keeps Pi profiles in its userData. The App's picker and dialogs stay in
// the App (project-daemon.ts); here the daemon gets what the App would send.

describe('daemon project and workspace selection', () => {
  it('remembers a chosen folder by its canonical path, and the App sees it as a known project', async () => {
    const daemon = await startTestDaemon()
    try {
      const target = join(daemon.root, 'chosen')
      mkdirSync(target)
      const link = join(daemon.root, 'chosen-link')
      symlinkSync(target, link)
      // The App's own readers, loaded before the daemon writes: their cache must follow.
      const app = createWorkspaceRuntime({ appUserDataDir: daemon.userDataDir, loadSessions: () => [] })
      expect(app.recentStore().load()).toEqual([daemon.workspace])
      expect(() => app.resolveKnownProjectDirectory(target)).toThrow('工作目录尚未通过 Scry 目录选择器授权')

      const chosen = await daemon.localOp('workspaceSelection', 'chooseFolder', [link])
      expect(chosen.error).toBeUndefined()
      expect(chosen.result).toBe(realpathSync(target))
      expect(app.recentStore().load()[0]).toBe(realpathSync(target))
      expect(app.projectStore().load().map((project) => project.cwd)).toContain(realpathSync(target))
      expect(app.resolveKnownProjectDirectory(link)).toBe(realpathSync(target))

      // Only an existing directory named by an absolute path; nothing is remembered otherwise.
      expect((await daemon.localOp('workspaceSelection', 'chooseFolder', ['relative/dir'])).error).toBe('无效的工作目录')
      expect((await daemon.localOp('workspaceSelection', 'chooseFolder', [42])).error).toBe('无效的工作目录')
      const file = join(daemon.root, 'a-file')
      writeFileSync(file, '')
      expect((await daemon.localOp('workspaceSelection', 'chooseFolder', [file])).error).toBe('工作目录不存在或不是文件夹')
      expect(createRecentFoldersStore(daemon.userDataDir).load()).toEqual([realpathSync(target), daemon.workspace])
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('pins, renames and removes projects and recent folders with main validation', async () => {
    const daemon = await startTestDaemon()
    try {
      expect((await daemon.localOp('workspaceSelection', 'chooseFolder', [daemon.workspace])).result).toBe(daemon.workspace)
      const project = () => createProjectStore(daemon.userDataDir).load().find((entry) => entry.cwd === daemon.workspace)

      expect((await daemon.localOp('projectStore', 'setProjectPinned', [daemon.workspace, true])).result).toBe(true)
      expect(project()?.pinnedAt).toBeTypeOf('number')
      expect((await daemon.localOp('projectStore', 'setProjectPinned', [daemon.workspace, 'yes'])).error).toBe('无效的项目置顶请求')
      expect((await daemon.localOp('projectStore', 'renameProject', [daemon.workspace, '  From the App  '])).result).toBe(true)
      expect(project()?.name).toBe('From the App')
      expect((await daemon.localOp('projectStore', 'renameProject', [daemon.workspace, ' '])).error).toBe('项目名称必须为 1–120 个字符')
      expect((await daemon.localOp('projectStore', 'renameProject', ['relative', 'x'])).error).toBe('无效的项目目录')

      // Removing a recent folder answers the list the renderer shows next.
      const other = join(daemon.root, 'other')
      mkdirSync(other)
      await daemon.localOp('workspaceSelection', 'chooseFolder', [other])
      expect((await daemon.localOp('projectStore', 'removeRecentFolder', [realpathSync(other)])).result).toEqual([daemon.workspace])
      expect((await daemon.localOp('projectStore', 'removeRecentFolder', [{ dir: other }])).error).toBe('无效的最近目录')

      expect((await daemon.localOp('projectStore', 'removeProject', [daemon.workspace])).result).toBe(true)
      expect(project()?.removedAt).toBeTypeOf('number')
      expect(createRecentFoldersStore(daemon.userDataDir).load()).toEqual([])
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('answers worktree selection for a known repository and refuses an unknown one', async () => {
    const daemon = await startTestDaemon()
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: daemon.workspace, stdio: 'ignore' })
      git('init', '-q', '-b', 'main')
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init')

      const read = await daemon.localOp('workspaceSelection', 'read', [{ cwd: daemon.workspace, kind: 'branches' }])
      expect(read.error).toBeUndefined()
      expect(read.result).toMatchObject({ status: 'available' })
      const repositoryId = (read.result as { data: { repositoryId: string } }).data.repositoryId
      expect(repositoryId).toMatch(/^[a-f0-9]{64}$/)

      // The repository id is only valid in the service that read it: the daemon's.
      expect((await daemon.localOp('workspaceSelection', 'validateBranch', [{ repositoryId, name: 'feature/one' }])).result)
        .toEqual({ status: 'available', data: { name: 'feature/one' } })
      expect((await daemon.localOp('workspaceSelection', 'validateBranch', [{ repositoryId, name: 'bad..name' }])).result)
        .toMatchObject({ status: 'failed' })
      expect((await daemon.localOp('workspaceSelection', 'inspectStart', [{ repositoryId, operationId: 'f4826a0a-ef56-4309-8d70-e3cd76f0181c' }])).result)
        .toEqual({ status: 'available', data: null })
      expect((await daemon.localOp('workspaceSelection', 'validateBranch', [{ repositoryId: 'a'.repeat(64), name: 'x' }])).result)
        .toEqual({ status: 'failed', reason: '仓库引用已过期，请重新读取工作区' })

      // A directory the daemon never authorized is not read.
      const stranger = join(daemon.root, 'stranger')
      mkdirSync(stranger)
      expect((await daemon.localOp('workspaceSelection', 'read', [{ cwd: stranger, kind: 'branches' }])).result)
        .toMatchObject({ status: 'failed', reason: expect.stringContaining('授权') })
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('invalidates a Provider context and refuses an unknown Provider', async () => {
    const daemon = await startTestDaemon()
    try {
      expect((await daemon.localOp('providerContext', 'invalidateProviderContext', [{ providerId: 'codex', cwd: daemon.workspace }])).result).toBe(true)
      expect((await daemon.localOp('providerContext', 'invalidateProviderContext', [{ providerId: 'nope', cwd: daemon.workspace }])).error).toBe('provider adapter not registered: nope')
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('adds a Pi profile after the RPC handshake, reports a failed one, and removes it', async () => {
    // The fixture set with a Pi adapter, so an added profile has a descriptor to report.
    const previous = process.env.SCRY_ELECTRON_SMOKE_CONVERSATIONS
    process.env.SCRY_ELECTRON_SMOKE_CONVERSATIONS = '1'
    const daemon = await startTestDaemon().finally(() => {
      if (previous === undefined) delete process.env.SCRY_ELECTRON_SMOKE_CONVERSATIONS
      else process.env.SCRY_ELECTRON_SMOKE_CONVERSATIONS = previous
    })
    try {
      const bin = join(daemon.root, 'bin')
      mkdirSync(bin)
      const launcher = join(bin, 'pi')
      writeFileSync(launcher, FAKE_PI)
      chmodSync(launcher, 0o755)
      const broken = join(bin, 'not-pi')
      writeFileSync(broken, '#!/bin/sh\nexit 3\n')
      chmodSync(broken, 0o755)
      const profiles = () => createPiAgentProfileStore(daemon.userDataDir).load()

      // A launcher that fails the handshake is reported for the App's dialog; nothing is stored.
      const failed = await daemon.localOp('piProfile', 'addPiProfile', [broken, daemon.workspace])
      expect(failed.error).toBeUndefined()
      expect(failed.result).toMatchObject({ status: 'failed', message: expect.any(String) })
      expect(profiles()).toEqual([])
      // The probe runs in the window's workspace only when the daemon knows that project.
      const stranger = join(daemon.root, 'stranger')
      mkdirSync(stranger)
      expect((await daemon.localOp('piProfile', 'addPiProfile', [launcher, stranger])).result)
        .toMatchObject({ status: 'failed', message: '工作目录尚未通过 Scry 目录选择器授权' })
      expect((await daemon.localOp('piProfile', 'addPiProfile', ['pi', null])).error).toBe('无效的 Pi Agent 启动器')
      expect(profiles()).toEqual([])

      const added = await daemon.localOp('piProfile', 'addPiProfile', [launcher, daemon.workspace])
      expect(added.error).toBeUndefined()
      const id = piProfileForExecutable(launcher).id
      expect(added.result).toMatchObject({ status: 'added', agent: { id, agentProfileId: id, bin: 'pi', path: realpathSync(launcher), version: '9.9.9' } })
      expect(profiles().map((profile) => profile.id)).toEqual([id])

      expect((await daemon.localOp('piProfile', 'removePiProfile', ['pi:default'])).error).toBe('无效的 Pi Agent Profile')
      expect((await daemon.localOp('piProfile', 'removePiProfile', [id])).result).toBe(true)
      expect(profiles()).toEqual([])
    } finally {
      await daemon.dispose()
    }
  }, 30_000)
})

// Just enough of Pi's RPC mode for the add handshake: a version and the four catalog reads.
const FAKE_PI = `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('9.9.9\\n'); process.exit(0) }
let buffer = ''
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const data = {
  get_state: { model: { provider: 'test', id: 'test-model' }, thinkingLevel: 'off', isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionId: 's', cwd: process.cwd() },
  get_available_models: { models: [{ provider: 'test', id: 'test-model', name: 'Test', contextWindow: 1000 }] },
  get_available_thinking_levels: { levels: ['off'] },
  get_commands: { commands: [] }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const raw = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!raw) continue
    const command = JSON.parse(raw)
    send({ type: 'response', id: command.id, command: command.type, success: true, data: data[command.type] ?? {} })
  }
})
`
