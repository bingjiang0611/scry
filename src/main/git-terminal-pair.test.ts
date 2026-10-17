import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  beginGitTurnDiff, cancelGitTurnDiff, cloneGitTurnDiffCapture,
  finishGitTurnAndSessionDiff, snapshotSessionNetDiff, type GitTurnDiffCapture
} from './git'
import { normalizeTurnDiffSnapshot } from '../shared/trace'

const control = vi.hoisted(() => ({
  holdObjectDir: '', entered: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
  unblock: undefined as (() => void) | undefined,
  failObjectDir: '', failArg: '', failure: 'git_error' as 'git_error' | 'deadline', failCleanup: '',
  onRemove: undefined as ((path: string) => void) | undefined
}))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const run = promisify(actual.execFile)
  const wrapped = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args)
  Object.defineProperty(wrapped, Symbol.for('nodejs.util.promisify.custom'), {
    value: async (...args: unknown[]) => {
      const argv = args[1] as string[]
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined
      const objectDir = options?.env?.GIT_OBJECT_DIRECTORY
      if (control.holdObjectDir && objectDir === control.holdObjectDir && argv.includes('--numstat')) {
        control.holdObjectDir = ''
        control.entered?.()
        await control.wait
      }
      if (control.failObjectDir && objectDir === control.failObjectDir && argv.includes(control.failArg)) {
        throw Object.assign(new Error('controlled Git failure'), control.failure === 'deadline'
          ? { killed: true, signal: 'SIGKILL' } : { code: 123 })
      }
      return Reflect.apply(run, actual, args)
    }
  })
  return { ...actual, execFile: wrapped }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: (...args: Parameters<typeof actual.rm>) => {
    control.onRemove?.(String(args[0]))
    if (control.failCleanup && String(args[0]) === control.failCleanup) {
      return Promise.reject(Object.assign(new Error('controlled cleanup failure'), { code: 'EACCES' }))
    }
    return actual.rm(...args)
  } }
})

const run = promisify(execFile)
beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  vi.stubEnv('GIT_TEMPLATE_DIR', '')
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) vi.stubEnv(key, undefined)
})
afterAll(() => vi.unstubAllEnvs())

async function withRepository(operation: (root: string, capture: (excluded?: string[]) => Promise<GitTurnDiffCapture>, track: (capture: GitTurnDiffCapture) => void) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-terminal-pair-')))
  const captures: GitTurnDiffCapture[] = []
  const stores = new Set<string>()
  const track = (value: GitTurnDiffCapture): void => {
    captures.push(value)
    if (value.tempDir) stores.add(value.tempDir)
  }
  try {
    await Promise.all(['a', 'b', 'private', 'dirty'].map(name => writeFile(join(root, `${name}.txt`), `base-${name}\n`)))
    await run('git', ['init', '-q', '.'], { cwd: root })
    await run('git', ['add', '.'], { cwd: root })
    await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'base'], { cwd: root })
    await writeFile(join(root, 'dirty.txt'), 'user dirt unchanged\n')
    await writeFile(join(root, 'private.txt'), 'user-private-before-session\n')
    await operation(root, async (excluded = []) => {
      const value = await beginGitTurnDiff(root, undefined, undefined, excluded)
      expect(value.status).toBe('ready')
      track(value)
      return value
    }, track)
  } finally {
    control.unblock?.()
    control.holdObjectDir = ''
    control.failObjectDir = ''
    control.failCleanup = ''
    control.onRemove = undefined
    await Promise.allSettled(captures.map(cancelGitTurnDiff))
    await Promise.all([...stores].map(path => rm(path, { recursive: true, force: true })))
    await rm(root, { recursive: true, force: true })
    control.entered = undefined
    control.wait = undefined
    control.unblock = undefined
  }
}

async function twoAnchors(root: string, capture: (excluded?: string[]) => Promise<GitTurnDiffCapture>) {
  const session = await capture()
  await writeFile(join(root, 'a.txt'), 'round-one\n')
  await writeFile(join(root, 'private.txt'), 'private-before-turn\n')
  const turn = await capture()
  await writeFile(join(root, 'a.txt'), 'round-two\n')
  await writeFile(join(root, 'b.txt'), 'new-b\n')
  await writeFile(join(root, 'private.txt'), 'private-after-turn\n')
  return { turn, session }
}

const missing = (path: string) => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })

describe('shared terminal after-tree ownership', () => {
  it('publishes turn before a blocked peer, pins source-only objects, survives cancellation and samples later changes only on the next snapshot', async () => {
    await withRepository(async (root, capture) => {
      const { turn, session } = await twoAnchors(root, capture)
      const store = turn.tempDir!
      const index = await readFile(join(root, '.git/index'))
      const entered = new Promise<void>(resolve => { control.entered = resolve })
      control.wait = new Promise<void>(resolve => { control.unblock = resolve })
      control.holdObjectDir = session.objectDir!
      const pair = finishGitTurnAndSessionDiff(turn, session)
      let turnSeen = false
      const observedTurn = pair.turn.then(value => { turnSeen = true; return value })
      let cancelled = false
      const cancellation = cancelGitTurnDiff(turn).then(() => { cancelled = true })
      try {
        await entered
        expect(turnSeen).toBe(true)
        expect(cancelled).toBe(false)
        const turnDiff = await observedTurn
        expect(turn.tempDir).toBeUndefined()
        expect(turnDiff.cleanup).toBe('ok')
        expect((await stat(store)).isDirectory()).toBe(true)
        await writeFile(join(root, 'a.txt'), 'later-external-change\n')
        control.unblock!()
        const net = await pair.session
        await cancellation
        expect(net.status).toBe('captured')
        expect(net.afterAt).toBe(turnDiff.afterAt)
        expect(net.collection?.sharedAfter).toBe('turn')
        expect(normalizeTurnDiffSnapshot(JSON.parse(JSON.stringify(net)))?.collection?.sharedAfter).toBe('turn')
        expect(normalizeTurnDiffSnapshot({ ...net, collection: { ...net.collection, sharedAfter: 'unknown' } })?.collection?.sharedAfter).toBeUndefined()
        expect(net.files.find(file => basename(file.path) === 'a.txt')?.patch).toContain('+round-two')
        expect(net.files.find(file => basename(file.path) === 'a.txt')?.patch).not.toContain('later-external')
        expect(net.files.find(file => basename(file.path) === 'private.txt')?.patch).toContain('-user-private-before-session')
        expect(turnDiff.files.find(file => basename(file.path) === 'private.txt')?.patch).toContain('-private-before-turn')
        expect(net.files.some(file => basename(file.path) === 'dirty.txt')).toBe(false)
        expect((await readFile(join(root, '.git/index'))).equals(index)).toBe(true)
        await missing(store)
        const next = await snapshotSessionNetDiff(session)
        expect(next.status).toBe('captured')
        expect(next.files.find(file => basename(file.path) === 'a.txt')?.patch).toContain('+later-external-change')
      } finally {
        control.unblock!()
        await Promise.allSettled([observedTurn, pair.session, cancellation])
      }
    })
  }, 20_000)

  it('keeps the original baseline objects alive for a cloned first turn even when the baseline is cancelled', async () => {
    await withRepository(async (root, capture, track) => {
      const session = await capture()
      const turn = await cloneGitTurnDiffCapture(session)
      track(turn)
      const turnDir = turn.tempDir!
      const baselineDir = session.tempDir!
      await writeFile(join(root, 'a.txt'), 'first-turn\n')
      const pair = finishGitTurnAndSessionDiff(turn, session)
      const cancellation = cancelGitTurnDiff(session)
      const [a, b] = await Promise.all([pair.turn, pair.session])
      await cancellation
      expect(a.status).toBe('captured')
      expect(b.files).toEqual(a.files)
      expect(b.afterAt).toBe(a.afterAt)
      await missing(turnDir)
      await missing(baselineDir)
    })
  }, 20_000)

  it('uses independent snapshots for different exclusions and shares equivalent exclusion sets regardless of order', async () => {
    await withRepository(async (root, capture) => {
      const session = await capture()
      const turn = await capture([join(root, 'b.txt')])
      await writeFile(join(root, 'a.txt'), 'after\n')
      await writeFile(join(root, 'b.txt'), 'after\n')
      const pair = finishGitTurnAndSessionDiff(turn, session)
      const [a, b] = await Promise.all([pair.turn, pair.session])
      expect(a.files.map(file => basename(file.path))).toEqual(['a.txt'])
      expect(b.files.map(file => basename(file.path)).sort()).toEqual(['a.txt', 'b.txt'])
      expect(b.collection?.sharedAfter).toBeUndefined()
      const first = await capture([join(root, 'a.txt'), join(root, 'b.txt')])
      const second = await capture([join(root, 'b.txt'), join(root, 'a.txt')])
      await writeFile(join(root, 'private.txt'), 'different\n')
      const equivalent = finishGitTurnAndSessionDiff(first, second)
      const [c, d] = await Promise.all([equivalent.turn, equivalent.session])
      expect(d.collection?.sharedAfter).toBe('turn')
      expect(d.afterAt).toBe(c.afterAt)
    })
  }, 20_000)

  it('does not reuse an after-tree across parent and child directory scopes', async () => {
    await withRepository(async (root, capture, track) => {
      const selected = join(root, 'selected')
      await mkdir(selected)
      await writeFile(join(selected, 'inside.txt'), 'before\n')
      const session = await capture()
      const turn = await beginGitTurnDiff(selected)
      track(turn)
      await writeFile(join(selected, 'inside.txt'), 'after\n')
      await writeFile(join(root, 'a.txt'), 'outside selected\n')
      const pair = finishGitTurnAndSessionDiff(turn, session)
      const [a, b] = await Promise.all([pair.turn, pair.session])
      expect(a.status).toBe('captured')
      expect(a.files.map(file => relative(root, file.path))).toEqual(['selected/inside.txt'])
      expect(b.files.map(file => relative(root, file.path)).sort()).toEqual(['a.txt', 'selected/inside.txt'])
      expect(b.collection?.sharedAfter).toBeUndefined()
    })
  }, 20_000)

  it('retains per-projection patch policy and session-only projection failures without losing a valid turn', async () => {
    await withRepository(async (root, capture) => {
      const { turn, session } = await twoAnchors(root, capture)
      const pair = finishGitTurnAndSessionDiff(turn, session, undefined, {}, { patchExcludeBasenames: ['a.txt'] })
      const [a, b] = await Promise.all([pair.turn, pair.session])
      expect(a.files.find(file => basename(file.path) === 'a.txt')?.patchStatus).toBe('captured')
      expect(b.files.find(file => basename(file.path) === 'a.txt')).toMatchObject({ patchStatus: 'unavailable', patchReason: 'policy' })
      const nextTurn = await capture()
      await writeFile(join(root, 'a.txt'), 'another-turn\n')
      control.failObjectDir = session.objectDir!
      control.failArg = '--numstat'
      control.failure = 'git_error'
      const failed = finishGitTurnAndSessionDiff(nextTurn, session)
      expect((await failed.turn).status).toBe('captured')
      expect(await failed.session).toMatchObject({ status: 'failed', reason: 'git_error', files: [] })
    })
  }, 20_000)

  it('keeps a valid session projection when the turn anchor is broken and honors the stronger full-snapshot request', async () => {
    await withRepository(async (root, capture) => {
      const { turn, session } = await twoAnchors(root, capture)
      turn.beforeTree = 'not-an-object'
      const pair = finishGitTurnAndSessionDiff(turn, session, undefined, { forceFull: true })
      expect(await pair.turn).toMatchObject({ status: 'failed', reason: 'git_error', files: [] })
      const net = await pair.session
      expect(net.status).toBe('captured')
      expect(net.collection).toMatchObject({ strategy: 'full_fallback', fallbackReason: 'forced', sharedAfter: 'turn' })
      expect(net.files.find(file => basename(file.path) === 'a.txt')?.patch).toContain('+round-two')
    })
  }, 20_000)

  it('rechecks and disables newly configured filters and hooks for the shared collection', async () => {
    await withRepository(async (root, capture) => {
      const { turn, session } = await twoAnchors(root, capture)
      const marker = join(root, 'executed-untrusted-config')
      const hooks = join(root, 'hooks')
      await mkdir(hooks)
      const script = join(hooks, 'post-index-change')
      await writeFile(script, `#!/bin/sh\nprintf unsafe > '${marker}'\n`)
      await chmod(script, 0o755)
      await run('git', ['config', 'core.hooksPath', hooks], { cwd: root })
      await run('git', ['config', 'filter.fixture.clean', `printf unsafe > '${marker}'`], { cwd: root })
      await run('git', ['config', 'filter.fixture.required', 'true'], { cwd: root })
      await writeFile(join(root, '.gitattributes'), 'a.txt filter=fixture\n')
      const pair = finishGitTurnAndSessionDiff(turn, session)
      const [a, b] = await Promise.all([pair.turn, pair.session])
      expect(a.status).toBe('captured')
      expect(b.status).toBe('captured')
      expect(b.collection?.sharedAfter).toBe('turn')
      await missing(marker)
    })
  }, 20_000)

  it('does not manufacture an empty successful session when the shared collection times out', async () => {
    await withRepository(async (root, capture) => {
      const { turn, session } = await twoAnchors(root, capture)
      control.failObjectDir = turn.objectDir!
      control.failArg = 'write-tree'
      control.failure = 'deadline'
      const pair = finishGitTurnAndSessionDiff(turn, session)
      const [a, b] = await Promise.all([pair.turn, pair.session])
      expect(a).toMatchObject({ status: 'timeout', reason: 'deadline', files: [] })
      expect(b).toMatchObject({ status: 'timeout', reason: 'deadline', files: [] })
      expect(b.beforeAt).toBe(session.beforeAt)
    })
  }, 20_000)

  it('includes the last owner deletion time in session captureMs instead of moving it outside snapshot diagnostics', async () => {
    await withRepository(async (root, capture) => {
      const { turn, session } = await twoAnchors(root, capture)
      const store = turn.tempDir!
      let clock = Date.now()
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
      control.onRemove = path => { if (path === store) clock += 13 }
      try {
        const pair = finishGitTurnAndSessionDiff(turn, session)
        const [a, b] = await Promise.all([pair.turn, pair.session])
        expect(a.captureMs).toBe(turn.captureMs)
        expect(b.captureMs).toBe(session.captureMs + 13)
        await missing(store)
      } finally {
        now.mockRestore()
        control.onRemove = undefined
      }
    })
  }, 20_000)

  it('reports the last owner cleanup failure on the session while the turn ownership was released successfully', async () => {
    await withRepository(async (root, capture) => {
      const { turn, session } = await twoAnchors(root, capture)
      const store = turn.tempDir!
      control.failCleanup = store
      const pair = finishGitTurnAndSessionDiff(turn, session)
      expect(await pair.turn).toMatchObject({ status: 'captured', cleanup: 'ok' })
      expect(await pair.session).toMatchObject({ status: 'captured', cleanup: 'failed' })
      expect((await stat(store)).isDirectory()).toBe(true)
    })
  }, 20_000)
})
