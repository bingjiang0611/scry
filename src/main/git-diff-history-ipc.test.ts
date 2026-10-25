import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGitDiffIpc } from './git'
import { registerTrustedIpcHandler } from './ipc-trust'
import { knownProjectDirectory } from './workspace-authorization'
import { readDiffCommits, readDiffCommitSnapshot } from '../core/turn-recorder/git-diff-history'

vi.mock('../core/turn-recorder/git-diff-history.js', () => ({ readDiffCommits: vi.fn(), readDiffCommitSnapshot: vi.fn() }))
const roots: string[] = []
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: string) => value.repeat(40)
async function boundary(channel: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-history-ipc-')))
  roots.push(root)
  const approved = join(root, 'approved'), outside = join(root, 'outside'), alias = join(root, 'alias'), escape = join(root, 'escape')
  await Promise.all([mkdir(approved), mkdir(outside)])
  await Promise.all([symlink(approved, alias), symlink(outside, escape)])
  const frame = { url: 'file:///app/renderer/index.html' }
  const contents = { mainFrame: frame }
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const authorize = vi.fn((cwd: string) => knownProjectDirectory(cwd, [approved]))
  let handler!: (event: IpcMainInvokeEvent, request: unknown) => unknown
  registerGitDiffIpc((registeredChannel, listener) => {
    if (channel !== registeredChannel) return
    registerTrustedIpcHandler({ handle: (_name, registered) => { handler = registered } }, channel, () => win, frame.url, listener)
  }, authorize)
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { approved, outside, alias, escape, frame, event, authorize,
    request: { cwd: approved, head: hash('a'), baseCommit: hash('b'), offset: 0, commit: hash('c') },
    invoke: async (request: unknown, sender = event) => handler(sender, request) }
}

describe('registered diff-history IPC boundaries', () => {
  it.each(['agent:gitDiffCommits', 'agent:gitCommitDiffSnapshot'])('%s rejects sender, payload and canonical authority before privileged reads', async channel => {
    const b = await boundary(channel)
    const readers = [vi.mocked(readDiffCommits), vi.mocked(readDiffCommitSnapshot)]
    for (const sender of [{ ...b.event, sender: {} }, { ...b.event, senderFrame: { url: b.frame.url } }]) {
      await expect(b.invoke(b.request, sender as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    }
    expect(b.authorize).not.toHaveBeenCalled()
    for (const input of [null, [], {}, { ...b.request, head: '--all' }, { ...b.request, baseCommit: 'HEAD' },
      { ...b.request, cwd: b.outside }, { ...b.request, cwd: b.escape },
      ...(channel === 'agent:gitDiffCommits' ? [-1, 1000, 0.5, NaN, '0'].map(offset => ({ ...b.request, offset }))
        : ['HEAD', '--help', null].map(commit => ({ ...b.request, commit })))]) await expect(b.invoke(input)).rejects.toThrow()
    for (const read of readers) expect(read).not.toHaveBeenCalled()
    vi.mocked(readDiffCommits).mockResolvedValue({ status: 'available', commits: [], nextOffset: null, truncated: false })
    vi.mocked(readDiffCommitSnapshot).mockResolvedValue({ status: 'failed', files: [], reason: 'git_error' })
    await b.invoke({ ...b.request, cwd: b.alias })
    const read = channel === 'agent:gitDiffCommits' ? readers[0] : readers[1]
    expect(read).toHaveBeenCalledExactlyOnceWith({ cwd: b.approved, head: hash('a'), baseCommit: hash('b'),
      ...(channel === 'agent:gitDiffCommits' ? { offset: 0 } : { commit: hash('c') }) })
    for (const read of readers) read.mockClear()
    b.frame.url = 'https://untrusted.invalid/'
    await expect(b.invoke(b.request)).rejects.toThrow('非可信 renderer')
    for (const read of readers) expect(read).not.toHaveBeenCalled()
  })

  it('coalesces aliases but never different pinned ranges; authorization runs for every caller', async () => {
    const b = await boundary('agent:gitDiffCommits')
    const finishes: Array<() => void> = []
    vi.mocked(readDiffCommits).mockImplementation(() => new Promise(resolve => finishes.push(() => resolve({ status: 'available', commits: [], nextOffset: null, truncated: false }))))
    const requests = [b.invoke(b.request), b.invoke({ ...b.request, cwd: b.alias }), b.invoke({ ...b.request, head: hash('d') })]
    await vi.waitFor(() => expect(readDiffCommits).toHaveBeenCalledTimes(2))
    expect(b.authorize).toHaveBeenCalledTimes(3)
    finishes.forEach(finish => finish())
    await Promise.all(requests)
    vi.mocked(readDiffCommits).mockResolvedValue({ status: 'unavailable', reason: 'git_error' })
    expect(await b.invoke(b.request)).toMatchObject({ status: 'unavailable' })
    expect(readDiffCommits).toHaveBeenCalledTimes(3)
  })

  it('bounds concurrent immutable reads and releases slots after failures', async () => {
    const b = await boundary('agent:gitCommitDiffSnapshot')
    const finishes: Array<() => void> = []
    vi.mocked(readDiffCommitSnapshot).mockImplementation(() => new Promise(resolve => finishes.push(() => resolve({ status: 'failed', files: [], reason: 'git_error' }))))
    const requests = ['a', 'b', 'c', 'd'].map(commit => b.invoke({ ...b.request, commit: hash(commit) }))
    await vi.waitFor(() => expect(readDiffCommitSnapshot).toHaveBeenCalledTimes(4))
    await expect(b.invoke({ ...b.request, commit: hash('e') })).rejects.toThrow('正在读取其他差异')
    expect(readDiffCommitSnapshot).toHaveBeenCalledTimes(4)
    finishes.forEach(finish => finish())
    await Promise.all(requests)
    vi.mocked(readDiffCommitSnapshot).mockResolvedValue({ status: 'failed', files: [], reason: 'git_error' })
    await b.invoke({ ...b.request, commit: hash('e') })
    expect(readDiffCommitSnapshot).toHaveBeenCalledTimes(5)
  })
})
