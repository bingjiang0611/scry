import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWorkspaceNumstat, registerGitDiffIpc } from './git'
import { readWorkspaceDiffSnapshot } from '../core/turn-recorder/git-workspace-snapshot'
import { registerTrustedIpcHandler } from './ipc-trust'
import { knownProjectDirectory } from './workspace-authorization'

vi.mock('../core/turn-recorder/git.js', () => ({ readWorkspaceNumstat: vi.fn() }))
vi.mock('../core/turn-recorder/git-workspace-snapshot.js', () => ({ readWorkspaceDiffSnapshot: vi.fn() }))

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('registered workspace Git diff boundary', () => {
  it('coalesces canonical aliases only while in flight and reauthorizes every caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-git-ipc-flight-'))
    roots.push(root)
    const alias = join(root, 'alias')
    const approved = join(root, 'approved')
    await mkdir(approved)
    await symlink(approved, alias)
    const canonical = await realpath(approved)
    const authorize = vi.fn((cwd: string) => knownProjectDirectory(cwd, [approved]))
    let handler!: (event: IpcMainInvokeEvent, cwd: unknown) => unknown
    registerGitDiffIpc((_channel, listener) => { handler = listener }, authorize)
    let finish!: (value: { status: 'captured'; files: [] }) => void
    const capture = vi.mocked(readWorkspaceNumstat)
    capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const event = {} as IpcMainInvokeEvent
    const first = handler(event, approved)
    const second = handler(event, alias)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledExactlyOnceWith(canonical))
    finish({ status: 'captured', files: [] })
    expect(await first).toEqual(await second)
    expect(authorize).toHaveBeenCalledTimes(2)
    capture.mockResolvedValueOnce({ status: 'failed', reason: 'git_error', files: [] })
    expect(await handler(event, approved)).toMatchObject({ status: 'failed' })
    capture.mockResolvedValueOnce({ status: 'captured', files: [] })
    expect(await handler(event, approved)).toMatchObject({ status: 'captured' })
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it('does not coalesce different comparison scopes for the same authorized cwd', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-git-scope-flight-')))
    roots.push(root)
    const authorize = vi.fn(() => root)
    let handler!: (event: IpcMainInvokeEvent, cwd: unknown, scope?: unknown) => unknown
    registerGitDiffIpc((channel, listener) => { if (channel === 'agent:gitDiffSnapshot') handler = listener }, authorize)
    const pending: Array<() => void> = []
    const capture = vi.mocked(readWorkspaceDiffSnapshot)
    capture.mockImplementation(() => new Promise(resolve => pending.push(() => resolve({ status: 'unavailable', reason: 'no_head', files: [] }))))
    const event = {} as IpcMainInvokeEvent
    const requests = [handler(event, root, 'branch'), handler(event, root, 'workspace'), handler(event, root, 'branch')]
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2))
    expect(capture.mock.calls.map(call => call[3]).sort()).toEqual(['branch', 'workspace'])
    expect(authorize).toHaveBeenCalledTimes(3)
    pending.forEach(finish => finish())
    await Promise.all(requests)
  })

  it.each(['agent:gitDiff', 'agent:gitDiffSnapshot'])('checks sender, payload and canonical project authority before %s capture', async channel => {
    const root = await mkdtemp(join(tmpdir(), 'scry-git-ipc-'))
    roots.push(root)
    const approved = join(root, 'approved')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(approved), mkdir(outside)])
    const approvedAlias = join(root, 'approved-alias')
    const escape = join(root, 'escape')
    await Promise.all([symlink(approved, approvedAlias), symlink(outside, escape)])
    const canonical = await realpath(approved)
    const frame = { url: 'file:///app/renderer/index.html' }
    const contents = { mainFrame: frame }
    const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
    let handler!: (event: IpcMainInvokeEvent, cwd: unknown, scope?: unknown) => unknown
    registerGitDiffIpc((registeredChannel, listener) => {
      if (registeredChannel !== channel) return
      registerTrustedIpcHandler({ handle: (_channel, registered) => { handler = registered } }, channel, () => win, frame.url, listener)
    }, (cwd) => knownProjectDirectory(cwd, [approved]))
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const invoke = async (cwd: unknown, sender = event, scope?: unknown): Promise<unknown> => handler(sender, cwd, scope)
    const capture = channel === 'agent:gitDiff' ? vi.mocked(readWorkspaceNumstat) : vi.mocked(readWorkspaceDiffSnapshot)
    capture.mockResolvedValue({ status: 'unavailable', reason: 'no_head', files: [] })

    for (const sender of [
      { ...event, sender: {} },
      { ...event, senderFrame: { url: frame.url } }
    ]) {
      await expect(invoke(approved, sender as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    }
    for (const cwd of [null, {}, 1, '', outside, escape]) {
      await expect(invoke(cwd)).rejects.toThrow()
    }
    expect(capture).not.toHaveBeenCalled()

    if (channel === 'agent:gitDiffSnapshot') {
      for (const scope of ['session', 'HEAD', {}, null]) await expect(invoke(approved, event, scope)).rejects.toThrow()
      expect(capture).not.toHaveBeenCalled()
      await invoke(approvedAlias, event, 'branch')
      expect(capture).toHaveBeenCalledExactlyOnceWith(canonical, [], undefined, 'branch')
      capture.mockClear()
    }

    await expect(invoke(approvedAlias)).resolves.toEqual({ status: 'unavailable', reason: 'no_head', files: [] })
    expect(capture).toHaveBeenCalledExactlyOnceWith(...(channel === 'agent:gitDiff' ? [canonical] : [canonical, [], undefined, 'workspace']))

    capture.mockClear()
    frame.url = 'https://untrusted.invalid/'
    await expect(invoke(approved)).rejects.toThrow('非可信 renderer')
    expect(capture).not.toHaveBeenCalled()
  })
})
