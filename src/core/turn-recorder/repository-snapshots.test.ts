import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { handleRecorderHook } from './recorder.js'
import { listRecords } from './store.js'

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
  expect(diff.status).toBe('partial')
  expect(diff.value).toHaveLength(3)
  expect(diff.value).toEqual([
    expect.objectContaining({ repoRoot: captured, requestedRoot: captured, status: 'captured' }),
    expect.objectContaining({ requestedRoot: join(root, 'failed'), status: 'failed', reason: 'git_error' }),
    expect.objectContaining({ requestedRoot: join(root, 'timeout'), status: 'timeout', reason: 'deadline' })
  ])
  expect(diff.value?.[1]).not.toHaveProperty('repoRoot')
  expect(diff.value?.[2]).not.toHaveProperty('repoRoot')
}, 15_000)
