import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlService } from '../main/source-control/service'
import { ScProcess } from '../main/source-control/process'
import type { TerminalPtyProcess } from '../main/terminal-manager'
import { createDesktopWorkbench, parseDesktopWorkbenchQuery, type DesktopWorkbenchHost } from '../main/remote/desktop-workbench'
import { validateDesktopWorkbenchResponse } from '../main/remote/desktop-workbench-response'
import { createRemoteWorkbench } from './remote-workbench'
import type { DesktopRemoteAPI } from '../shared/desktop-remote'
import { readWorkspaceFile, writeWorkspaceFile } from '../main/workspace-files'
import type { DesktopTerminalEvents } from '../shared/desktop-workbench'
import type { TerminalSessionInfo } from '../shared/terminal'

let temp: string, cwd: string, other: string, home: string
let service: SourceControlService, host: DesktopWorkbenchHost
let authorized: Set<string>
let onData: (data: string) => void
let onExit: (event: { exitCode: number; signal?: number }) => void
const writes = vi.fn(), resize = vi.fn(), openPath = vi.fn(), trashItem = vi.fn()
const peer = 'a'.repeat(64)
const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
const request = (surface: 'workspace' | 'terminal' | 'sourceControl', method: string, args: unknown[], directory = cwd, owner = peer) => host.request(owner, parseDesktopWorkbenchQuery({ surface, method, args, cwd: directory }), () => {})
beforeEach(async () => {
  vi.clearAllMocks()
  temp = await realpath(await mkdtemp(join(tmpdir(), 'scry-desktop-workbench-')))
  cwd = join(temp, 'remote workspace'); other = join(temp, 'other'); home = join(temp, 'home')
  await Promise.all([mkdir(cwd), mkdir(other), mkdir(home)])
  authorized = new Set([cwd, other])
  const authorize = (directory: string) => { if (!authorized.has(directory)) throw new Error('workspace_not_authorized'); return directory }
  service = new SourceControlService({ userData: join(temp, 'state'), authorizeDirectory: authorize, unsettledDirectories: () => [], process: new ScProcess(() => ({ PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })) })
  host = createDesktopWorkbench({ directory: join(temp, 'recordings'), authorizeWorkspace: authorize, sourceControl: service, environment: async () => ({ PATH: '/usr/bin:/bin', HOME: home }), openPath, trashItem,
    pty: { spawn: (_shell, _args, options): TerminalPtyProcess => {
      expect(options.cwd).toBe(cwd)
      return { pid: 123, onData: callback => { onData = callback; return { dispose() {} } }, onExit: callback => { onExit = callback; return { dispose() {} } }, write: writes, resize, pause() {}, resume() {}, kill: () => onExit({ exitCode: 0 }), destroy: () => onExit({ exitCode: 0 }) }
    } }
  })
})
afterEach(async () => { await host.dispose(); await service.dispose(); await rm(temp, { recursive: true, force: true }) })

describe('authenticated desktop workspace operations', () => {
  it('edits and creates real files with revision checks, rename/move, and host-only external actions', async () => {
    await writeFile(join(cwd, 'file.txt'), 'before')
    const file = await request('workspace', 'workspaceRead', [{ cwd, path: 'file.txt' }]) as { revision: string }
    await request('workspace', 'workspaceWrite', [{ cwd, path: 'file.txt', content: 'after', expectedRevision: file.revision }])
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('after')
    await expect(request('workspace', 'workspaceWrite', [{ cwd, path: 'file.txt', content: 'stale', expectedRevision: file.revision }])).rejects.toThrow('发生变化')
    await request('workspace', 'workspaceCreate', [{ cwd, name: 'folder', kind: 'directory' }])
    await request('workspace', 'workspaceRename', [{ cwd, path: 'file.txt', name: 'renamed.txt' }])
    await request('workspace', 'workspaceMove', [{ cwd, path: 'renamed.txt', parentPath: 'folder' }])
    await request('workspace', 'workspaceOpenExternal', [{ cwd, path: 'folder/renamed.txt' }])
    expect(openPath).toHaveBeenCalledWith(join(cwd, 'folder/renamed.txt'))
    await request('workspace', 'workspaceTrash', [{ cwd, path: 'folder/renamed.txt' }])
    expect(trashItem).toHaveBeenCalledWith(join(cwd, 'folder/renamed.txt'))
  })
  it('rejects mismatched cwd, removed grants, traversal, symlink escape and malformed kinds without writing', async () => {
    await writeFile(join(other, 'protected.txt'), 'unchanged')
    await symlink(other, join(cwd, 'escape'))
    await expect(request('workspace', 'workspaceRead', [{ cwd: other, path: 'protected.txt' }])).rejects.toThrow('context_mismatch')
    for (const path of ['../other/protected.txt', 'escape/protected.txt']) {
      await expect(request('workspace', 'workspaceReadKnown', [{ cwd, path }])).rejects.toThrow()
    }
    await expect(request('workspace', 'workspaceCreate', [{ cwd, name: 'bad', kind: 'executable' }])).rejects.toThrow('invalid_workspace_kind')
    authorized.delete(cwd)
    await expect(request('workspace', 'workspaceCreate', [{ cwd, name: 'bad', kind: 'file' }])).rejects.toThrow('not_authorized')
    expect(await readFile(join(other, 'protected.txt'), 'utf8')).toBe('unchanged')
  })
  it('uses canonical source-control operations and rejects a repository reference from another workspace', async () => {
    git('init', '-b', 'feature'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false')
    await writeFile(join(cwd, 'file.txt'), 'content')
    const snapshot = await service.read(cwd)
    if (snapshot.status !== 'available') throw new Error(snapshot.reason)
    const input = { repositoryId: snapshot.data.id, expectedRevision: snapshot.data.revision, action: 'stage', paths: ['file.txt'], operationId: randomUUID() }
    await expect(request('sourceControl', 'mutate', [input], other)).rejects.toThrow('repository_context_mismatch')
    const operation = await request('sourceControl', 'mutate', [input]) as { status: string }
    expect(operation.status).toBe('succeeded')
    expect(git('diff', '--cached', '--name-only')).toBe('file.txt')
    await request('sourceControl', 'saveCommitDraft', [{ repositoryId: snapshot.data.id, head: null, message: 'remote draft' }])
    expect(await request('sourceControl', 'loadCommitDraft', [{ repositoryId: snapshot.data.id }])).toMatchObject({ message: 'remote draft' })
  })
})

describe('desktop terminal ownership, streaming and lifecycle', () => {
  const start = () => request('terminal', 'terminalStart', [{ cwd, cols: 80, rows: 24, scopeId: 'conversation' }]) as Promise<TerminalSessionInfo>
  it('streams real manager events with replayable cursor and rejects stale, cross-workspace and cross-peer input', async () => {
    const session = await start()
    await request('terminal', 'terminalReady', [session.id, session.ownershipEpoch])
    onData('remote output\n')
    const first = await request('terminal', 'terminalEvents', []) as DesktopTerminalEvents
    // Flush uses a timer for small chunks, as in the production local bridge.
    await vi.waitFor(async () => {
      const page = await request('terminal', 'terminalEvents', []) as DesktopTerminalEvents
      expect(page.events.some(row => row.kind === 'data' && row.events.some(event => event.data.includes('remote output')))).toBe(true)
    })
    const page = await request('terminal', 'terminalEvents', []) as DesktopTerminalEvents
    expect(await request('terminal', 'terminalEvents', [])).toEqual(page)
    await request('terminal', 'terminalEvents', [page.cursor])
    expect((await request('terminal', 'terminalEvents', [page.cursor]) as DesktopTerminalEvents).events).toEqual([])
    expect(first.cursor).toMatch(/^[a-f0-9-]{36}:\d+$/)
    await request('terminal', 'terminalWrite', [session.id, session.ownershipEpoch, 'pwd\r'])
    expect(writes).toHaveBeenCalledExactlyOnceWith('pwd\r')
    await expect(request('terminal', 'terminalWrite', [session.id, session.ownershipEpoch, 'bad'], other)).rejects.toThrow('stale_terminal_owner')
    await expect(request('terminal', 'terminalWrite', [session.id, session.ownershipEpoch, 'bad'], cwd, 'b'.repeat(64))).rejects.toThrow('stale_terminal_owner')
    const attached = await request('terminal', 'terminalAttach', [session.id]) as TerminalSessionInfo
    await expect(request('terminal', 'terminalResize', [session.id, session.ownershipEpoch, 100, 30])).rejects.toThrow('stale_terminal_owner')
    await request('terminal', 'terminalResize', [session.id, attached.ownershipEpoch, 100, 30])
    expect(resize).toHaveBeenCalledWith(100, 30)
    await host.release(peer)
    expect(await request('terminal', 'terminalActive', [])).toEqual([])
  })
  it('recovers a dropped final cumulative ACK without replaying terminal input or losing exit', async () => {
    let dropped = false
    const lostAck = vi.fn()
    const api = { workbench: vi.fn(async (_connection, query) => {
      if (query.method === 'terminalAck' && !dropped) { dropped = true; lostAck(); throw new Error('ACK lost before dispatch') }
      return host.request(peer, parseDesktopWorkbenchQuery(query), () => {})
    }) } as unknown as DesktopRemoteAPI
    const remote = createRemoteWorkbench(api, 'mac2', cwd)
    const exited = vi.fn()
    const offExit = remote.terminal.onTerminalExit(exited)
    const offData = remote.terminal.onTerminalData(event => {
      void remote.terminal.terminalAck(event.id, event.ownershipEpoch, Buffer.byteLength(event.data)).catch(() => {})
    })
    try {
      const session = await remote.terminal.terminalStart({ cwd, cols: 80, rows: 24 })
      await remote.terminal.terminalReady(session.id, session.ownershipEpoch)
      await remote.terminal.terminalWrite(session.id, session.ownershipEpoch, 'one command\r')
      onData('final output'); onExit({ exitCode: 0 })
      await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1))
      expect(lostAck).toHaveBeenCalledTimes(1)
      expect(writes).toHaveBeenCalledExactlyOnceWith('one command\r')
    } finally { offData(); offExit(); remote.dispose() }
  })

  it('rechecks authorization at the filesystem and Git mutation dispatch points', async () => {
    await writeFile(join(cwd, 'file.txt'), 'original')
    const snapshot = await readWorkspaceFile({ cwd, path: 'file.txt' })
    await expect(writeWorkspaceFile({ cwd, path: 'file.txt', content: 'forbidden', expectedRevision: snapshot.revision }, () => { throw new Error('revoked') })).rejects.toThrow('revoked')
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('original')
    git('init', '-b', 'feature')
    const repository = await service.read(cwd)
    if (repository.status !== 'available') throw new Error(repository.reason)
    const result = await service.mutate({ repositoryId: repository.data.id, expectedRevision: repository.data.revision, action: 'stage', paths: ['file.txt'], operationId: randomUUID() }, () => { throw new Error('device_revoked') })
    expect(result.status).toBe('failed')
    expect(git('diff', '--cached', '--name-only')).toBe('')
  })

  it('rejects unrecognized surfaces/methods and malformed transport responses', () => {
    expect(() => parseDesktopWorkbenchQuery({ cwd, surface: 'terminal', method: 'exec', args: [] })).toThrow('invalid_workbench_method')
    expect(() => validateDesktopWorkbenchResponse({ cwd, surface: 'terminal', method: 'terminalStart', args: [{ cwd, cols: 80, rows: 24 }] }, { id: 'fake' })).toThrow('invalid_desktop_workbench_response')
  })
})
