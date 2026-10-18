import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitNumstat, registerGitDiffIpc } from './git'
import { registerTrustedIpcHandler } from './ipc-trust'
import { knownProjectDirectory } from './workspace-authorization'

vi.mock('../core/turn-recorder/git.js', () => ({ gitNumstat: vi.fn() }))

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('registered workspace Git diff boundary', () => {
  it('checks sender, payload and canonical project authority before Git capture', async () => {
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
    let handler!: (event: IpcMainInvokeEvent, cwd: unknown) => unknown
    registerGitDiffIpc((channel, listener) => {
      expect(channel).toBe('agent:gitDiff')
      registerTrustedIpcHandler({ handle: (_channel, registered) => { handler = registered } }, channel, () => win, frame.url, listener)
    }, (cwd) => knownProjectDirectory(cwd, [approved]))
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const invoke = async (cwd: unknown, sender = event): Promise<unknown> => handler(sender, cwd)
    const capture = vi.mocked(gitNumstat)
    capture.mockResolvedValue({ status: 'captured', files: [] })

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

    await expect(invoke(approvedAlias)).resolves.toEqual({ status: 'captured', files: [] })
    expect(capture).toHaveBeenCalledExactlyOnceWith(canonical)

    capture.mockClear()
    frame.url = 'https://untrusted.invalid/'
    await expect(invoke(approved)).rejects.toThrow('非可信 renderer')
    expect(capture).not.toHaveBeenCalled()
  })
})
