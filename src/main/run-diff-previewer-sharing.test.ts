import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RunDiffPreviewer } from './session-diff'
import { beginGitTurnDiff, cancelGitTurnDiff, cloneGitTurnDiffCapture, previewGitTurnDiff, type GitTurnDiffCapture, type GitTurnDiffFinishOptions } from './git'
import type { TurnDiffSnapshot } from '../shared/trace'

const exec = promisify(execFile)
const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

function captures(): [GitTurnDiffCapture, GitTurnDiffCapture] {
  const sharedStorage = { rootDir: '/scratch/owner', objectDir: '/scratch/owner/objects', refs: 2 }
  const turn: GitTurnDiffCapture = {
    status: 'ready', beforeAt: '2026-10-30T00:00:00.000Z', captureMs: 0,
    beforeTree: 'before-tree', repoRoot: '/repo', scope: '.', pathspec: ['.'],
    tempDir: '/scratch/owner', objectDir: '/scratch/owner/objects', sharedStorage
  }
  return [turn, { ...turn, tempDir: '/scratch/clone', objectDir: '/scratch/clone/objects' }]
}

function snapshot(): TurnDiffSnapshot {
  return { version: 1, status: 'captured', repoRoot: '/repo', scope: '.', beforeAt: 'before', afterAt: 'after', captureMs: 1, cleanup: 'ok', files: [] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(pair = captures(), hints: GitTurnDiffFinishOptions = {}) {
  const pending = deferred<TurnDiffSnapshot | null>()
  const read = vi.fn(() => pending.promise)
  const emit = vi.fn()
  const onError = vi.fn()
  const previewer = new RunDiffPreviewer({ runId: 'run', turnCapture: Promise.resolve(pair[0]), sessionCapture: Promise.resolve(pair[1]), hints: () => hints, preview: read, emit, onError, minIntervalMs: 0 })
  closers.push(async () => { pending.resolve(null); previewer.sealAll(); await previewer.idle() })
  return { pair, pending, read, emit, onError, previewer }
}

async function started() { await Promise.resolve(); await Promise.resolve() }

describe('same-baseline live diff preview reads', () => {
  it('shares only the ongoing read, publishes both scopes, and reads again on the next write', async () => {
    const f = fixture(captures(), { structuredPaths: ['tracked.txt'] })
    const first = f.previewer.notifyChange()
    await started()
    expect(f.read).toHaveBeenCalledTimes(1)
    f.pending.resolve(snapshot())
    await first
    expect(f.emit.mock.calls.map(([event]) => event.scope)).toEqual(['turn', 'session'])
    await f.previewer.notifyChange()
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.emit).toHaveBeenCalledTimes(4)
  })

  it.each(['beforeTree', 'scope', 'repoRoot'] as const)('does not share different %s', async field => {
    const pair = captures()
    pair[1][field] = 'different'
    const f = fixture(pair)
    const done = f.previewer.notifyChange()
    await started()
    expect(f.read).toHaveBeenCalledTimes(2)
    f.pending.resolve(snapshot())
    await done
  })

  it('does not share independent baseline ownership even if the paths and tree hashes match', async () => {
    const pair = captures()
    pair[1].sharedStorage = { ...pair[0].sharedStorage! }
    const f = fixture(pair)
    const done = f.previewer.notifyChange()
    await started()
    expect(f.read).toHaveBeenCalledTimes(2)
    f.pending.resolve(snapshot())
    await done
  })

  it.each([{ patchExcludeBasenames: ['private.txt'] }, { forceFull: true }, { completePatches: true }, { workspaceSnapshot: true }])('preserves distinct collection/output policies %j', async hints => {
    const f = fixture(captures(), hints)
    const done = f.previewer.notifyChange()
    await started()
    expect(f.read).toHaveBeenCalledTimes(2)
    f.pending.resolve(snapshot())
    await done
  })

  it.each(['excludedPaths', 'pathspec'] as const)('does not share different %s', async field => {
    const pair = captures()
    pair[1][field] = ['other']
    const f = fixture(pair)
    const done = f.previewer.notifyChange()
    await started()
    expect(f.read).toHaveBeenCalledTimes(2)
    f.pending.resolve(snapshot())
    await done
  })

  it('returns independent snapshots and preserves each observation start', async () => {
    const pair = captures()
    pair[1].beforeAt = 'session-before'
    const f = fixture(pair)
    f.emit.mockImplementation(event => { if (event.scope === 'turn') event.snapshot.captureMs = 999 })
    const done = f.previewer.notifyChange()
    await started()
    f.pending.resolve(snapshot())
    await done
    const session = f.emit.mock.calls.find(([event]) => event.scope === 'session')![0]
    expect(session.snapshot.captureMs).toBe(1)
    expect(session.snapshot.beforeAt).toBe('session-before')
  })

  it('does not publish a shared result after the requesting baseline is disposed', async () => {
    const f = fixture()
    const done = f.previewer.notifyChange()
    await started()
    f.pair[1].sharedStorage = undefined
    f.pair[1].tempDir = undefined
    f.pending.resolve(snapshot())
    await done
    expect(f.emit.mock.calls.map(([event]) => event.scope)).toEqual(['turn'])
  })

  it('keeps terminal sealing independent across the two scopes', async () => {
    const f = fixture()
    const done = f.previewer.notifyChange()
    await started()
    f.previewer.seal('turn')
    f.pending.resolve(snapshot())
    await done
    expect(f.emit.mock.calls.map(([event]) => event.scope)).toEqual(['session'])
  })

  it('reports a failed read to both waiting scopes without caching the failure', async () => {
    const f = fixture()
    const done = f.previewer.notifyChange()
    await started()
    f.pending.reject(new Error('read failed'))
    await done
    expect(f.onError).toHaveBeenCalledTimes(2)
    expect(f.emit).not.toHaveBeenCalled()
    f.read.mockResolvedValue(snapshot())
    await f.previewer.notifyChange()
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.emit).toHaveBeenCalledTimes(2)
  })
})

it('reuses a real Git preview without losing modified, deleted or untracked file evidence or consuming either capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-preview-sharing-'))
  let turn: GitTurnDiffCapture | undefined
  let session: GitTurnDiffCapture | undefined
  const git = (...args: string[]) => exec('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  try {
    await git('init', '-q')
    await git('config', 'user.name', 'bingjiang0611')
    await git('config', 'user.email', '307659028+bingjiang0611@users.noreply.github.com')
    await writeFile(join(root, 'tracked.txt'), 'old\n')
    await writeFile(join(root, 'deleted.txt'), 'removed\n')
    await git('add', '.')
    await git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-qm', 'fixture')
    turn = await beginGitTurnDiff(root)
    session = await cloneGitTurnDiffCapture(turn)
    expect(turn.status).toBe('ready')
    await writeFile(join(root, 'tracked.txt'), 'new\n')
    await writeFile(join(root, 'untracked.txt'), 'created\n')
    await unlink(join(root, 'deleted.txt'))
    const read = vi.fn(previewGitTurnDiff)
    const events: TurnDiffSnapshot[] = []
    const previewer = new RunDiffPreviewer({ runId: 'real', turnCapture: Promise.resolve(turn), sessionCapture: Promise.resolve(session), hints: () => ({ structuredPaths: ['tracked.txt'] }), preview: read, emit: event => { events.push(event.snapshot) }, minIntervalMs: 0 })
    closers.push(async () => { previewer.sealAll(); await previewer.idle() })
    await previewer.notifyChange()
    expect(read).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(2)
    const independent = await previewGitTurnDiff(session)
    expect(independent?.status).toBe('captured')
    expect(events[0].files?.map(file => file.path).sort()).toEqual(['deleted.txt', 'tracked.txt', 'untracked.txt'].map(name => join(turn!.repoRoot!, name)))
    expect(events[0].files).toEqual(independent!.files)
    expect(events[1].files).toEqual(independent!.files)
    await writeFile(join(root, 'tracked.txt'), 'newer\n')
    await previewer.notifyChange()
    const latest = await previewGitTurnDiff(session)
    expect(read).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(4)
    expect(events[2].files).toEqual(latest!.files)
    expect(events[3].files).toEqual(latest!.files)
    expect(events[2].files).not.toEqual(events[0].files)
    expect(turn.finishPromise).toBeUndefined()
    expect(session.finishPromise).toBeUndefined()
    expect(turn.tempDir).toBeTruthy()
    expect(session.tempDir).toBeTruthy()
  } finally {
    if (turn) await cancelGitTurnDiff(turn)
    if (session) await cancelGitTurnDiff(session)
    await rm(root, { recursive: true, force: true })
  }
})
