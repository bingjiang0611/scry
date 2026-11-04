import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { beginGitTurnDiff } from './git-capture.js'
import { handleRecorderHook } from './recorder.js'
import { listRecords } from './store.js'
import { isAgentTurnRecord } from '../../shared/turn-record.js'
import { normalizeTurnDiffSnapshot } from '../../shared/trace.js'

// Inject two baseline failures, not synthetic records. Discovery, successful Git capture,
// finish, aggregation, commit and cold record reads all use production implementations.
vi.mock('./git.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./git.js')>()
  return { ...actual, beginGitTurnDiff: (...args: Parameters<typeof actual.beginGitTurnDiff>) => {
    const name = basename(args[0])
    if (name === 'timeout' || name === 'failed') return Promise.resolve({
      beforeAt: new Date().toISOString(), captureMs: 5, requestedRoot: args[0],
      status: name, reason: name === 'timeout' ? 'deadline' : 'git_error'
    })
    return actual.beginGitTurnDiff(...args)
  } }
})

const roots: string[] = []
const exec = promisify(execFile)
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('retains every discovered repository and its captured/timeout/failed outcome even at the same timestamp', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-snapshot-status-')))
  roots.push(root)
  for (const name of ['captured', 'timeout', 'failed']) await mkdir(join(root, name, '.git'), { recursive: true })
  const captured = join(root, 'captured')
  await exec('git', ['init', '-q', captured])
  await writeFile(join(captured, 'README.md'), 'before\n')
  await exec('git', ['-C', captured, 'add', 'README.md'])
  await exec('git', ['-C', captured, '-c', 'user.name=bingjiang0611', '-c', 'user.email=307659028+bingjiang0611@users.noreply.github.com', 'commit', '-qm', 'fixture'])
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'snapshots', dataDir: '.scry',
    repositories: { mode: 'discover-nested-git' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  // Simultaneous finishes must not collapse different repositories into one harness event.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-25T12:00:00Z'))
  const payload = { session_id: 'snapshot-session', turn_id: 'snapshot-turn', timestamp: new Date().toISOString() }
  await handleRecorderHook({ provider: 'pi', workspace: root, env: {}, event: 'UserPromptSubmit', payload: { ...payload, prompt: 'change README' } })
  await writeFile(join(captured, 'README.md'), 'after\n')
  await handleRecorderHook({ provider: 'pi', workspace: root, env: {}, event: 'Stop', payload: { ...payload, timestamp: new Date().toISOString(), assistant_response: 'done' } })
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  const diff = records[0].diff
  expect(diff).toMatchObject({ discovery: { requestedRoots: [captured, join(root, 'failed'), join(root, 'timeout')], maxDepth: 2, depthLimitedDirectories: 0 } })
  expect(diff.status).toBe('partial')
  expect(diff.value).toHaveLength(3)
  expect(diff.value).toEqual([
    expect.objectContaining({ repoRoot: captured, requestedRoot: captured, status: 'captured' }),
    expect.objectContaining({ requestedRoot: join(root, 'failed'), status: 'failed', reason: 'git_error' }),
    expect.objectContaining({ requestedRoot: join(root, 'timeout'), status: 'timeout', reason: 'deadline' })
  ])
  expect(diff.value?.[1]).not.toHaveProperty('repoRoot')
  expect(diff.value?.[2]).not.toHaveProperty('repoRoot')
  expect(normalizeTurnDiffSnapshot({ version: 1, ...diff.value?.[1] })?.requestedRoot).toBe(join(root, 'failed'))
  const invalid = { ...records[0], diff: { ...diff, value: diff.value?.map(snapshot => ({ ...snapshot, requestedRoot: 42 })) } }
  expect(isAgentTurnRecord(invalid)).toBe(false)
  expect(isAgentTurnRecord({ ...records[0], diff: { ...diff, discovery: { ...diff.discovery, requestedRoots: [captured, captured] } } })).toBe(false)
  expect(isAgentTurnRecord({ ...records[0], diff: { ...diff, discovery: { ...diff.discovery, depthLimitedDirectories: -1 } } })).toBe(false)
  const { discovery: _discovery, ...legacyDiff } = diff
  const legacy = { ...records[0], diff: { ...legacyDiff, value: diff.value?.map(({ requestedRoot: _requestedRoot, ...snapshot }) => snapshot) } }
  expect(isAgentTurnRecord(legacy)).toBe(true)
}, 15_000)

// The finish path may reuse the start capture's index instead of rebuilding it with
// `read-tree --reset`; the candidate set must stay exactly the worktree-vs-baseline one.
async function committedRepo(name: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `scry-reuse-${name}-`)))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  await exec('git', ['init', '-q', repo])
  await writeFile(join(repo, 'README.md'), 'before\n')
  await exec('git', ['-C', repo, 'add', 'README.md'])
  await exec('git', ['-C', repo, '-c', 'user.name=bingjiang0611', '-c', 'user.email=307659028+bingjiang0611@users.noreply.github.com', 'commit', '-qm', 'fixture'])
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: name, dataDir: '.scry',
    repositories: { mode: 'discover-nested-git' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  return root
}

async function turnDiffOf(root: string, session: string) {
  const payload = { session_id: session, turn_id: session, timestamp: new Date().toISOString(), cwd: root }
  await handleRecorderHook({ provider: 'pi', workspace: root, env: {}, event: 'UserPromptSubmit', payload: { ...payload, prompt: 'change files' } })
  return payload
}

// 复用启动 index 是纯性能优化：发布错了不会改结果，只会白跑调用。用直接观测把发布条件钉住。
it('publishes the reusable start index only while sparse checkout is off', async () => {
  const dirtyRoot = await committedRepo('index-publish')
  const dirtyRepo = join(dirtyRoot, 'repo')
  await writeFile(join(dirtyRepo, 'untracked.txt'), 'later\n')
  const dirty = await beginGitTurnDiff(dirtyRepo, 15_000)
  expect(dirty.status).toBe('ready')
  expect(dirty.baselineClean).toBe(false)
  expect(dirty.beforeIndex).toBeDefined()

  const cleanRoot = await committedRepo('index-publish-clean')
  const clean = await beginGitTurnDiff(join(cleanRoot, 'repo'), 15_000)
  expect(clean.baselineClean).toBe(true)
  expect(clean.indexState).toBeDefined()

  await writeFile(join(dirtyRepo, '.git', 'info', 'sparse-checkout'), '')
  const sparse = await beginGitTurnDiff(dirtyRepo, 15_000)
  expect(sparse.status).toBe('ready')
  expect(sparse.beforeIndex).toBeUndefined()
  expect(sparse.indexState).toBeUndefined()
}, 20_000)

it('captures a dirty worktree that appears after a clean start', async () => {
  const root = await committedRepo('clean-start')
  const repo = join(root, 'repo')
  const payload = await turnDiffOf(root, 'reuse-clean')
  const snapshot = JSON.parse(JSON.stringify(payload))
  await writeFile(join(repo, 'README.md'), 'after\n')
  await writeFile(join(repo, 'new.txt'), 'untracked\n')
  await handleRecorderHook({ provider: 'pi', workspace: root, env: {}, event: 'Stop', payload: { ...snapshot, assistant_response: 'done', timestamp: new Date().toISOString() } })
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  const files = records[0].diff.value?.flatMap(snapshot => snapshot.files ?? []) ?? []
  expect(files.map(file => [basename(file.path), file.change]).sort()).toEqual([['README.md', 'modified'], ['new.txt', 'added']])
}, 20_000)

it('still captures the turn when the user rewrote the index mid-turn', async () => {
  const root = await committedRepo('staged-midturn')
  const repo = join(root, 'repo')
  const payload = await turnDiffOf(root, 'reuse-staged')
  await writeFile(join(repo, 'README.md'), 'staged\n')
  await exec('git', ['-C', repo, 'add', 'README.md'])
  await writeFile(join(repo, 'staged-only.txt'), 'later\n')
  await exec('git', ['-C', repo, 'add', 'staged-only.txt'])
  await exec('git', ['-C', repo, 'reset', '-q', 'staged-only.txt'])
  await handleRecorderHook({ provider: 'pi', workspace: root, env: {}, event: 'Stop', payload: { ...payload, assistant_response: 'done', timestamp: new Date().toISOString() } })
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  const files = records[0].diff.value?.flatMap(snapshot => snapshot.files ?? []) ?? []
  expect(files.map(file => [basename(file.path), file.change]).sort()).toEqual([['README.md', 'modified'], ['staged-only.txt', 'added']])
}, 20_000)
