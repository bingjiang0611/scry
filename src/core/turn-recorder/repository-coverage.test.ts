import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { runScryCli } from '../../cli/scry.js'
import { discoverRepositories, type RecorderConfig } from './config.js'
import { handleRecorderHook, recoverRecorder } from './recorder.js'
import { recorderSessionRoot, type RecorderOpenTurnState } from './runtime-state.js'
import { listRecords } from './store.js'

const exec = promisify(execFile)
const roots: string[] = []
const config: RecorderConfig = {
  schemaVersion: 1, enabled: true, workspaceId: 'coverage', dataDir: '.scry',
  repositories: { mode: 'discover-nested-git' },
  capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
}

async function workspace(nestedRepository = true): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-repository-coverage-')))
  roots.push(root)
  await mkdir(join(root, nestedRepository ? 'a/b/c/.git' : 'src/features/auth'), { recursive: true })
  await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
  await writeFile(join(root, '.gitignore'), '.scry/\na/\nscry.config.json\n')
  await writeFile(join(root, 'README.md'), 'before\n')
  await exec('git', ['init', '-q', root])
  await exec('git', ['-C', root, 'add', '.gitignore', 'README.md'])
  await exec('git', ['-C', root, '-c', 'user.name=bingjiang0611', '-c', 'user.email=307659028+bingjiang0611@users.noreply.github.com', 'commit', '-qm', 'fixture'])
  return root
}

async function recordTurn(root: string) {
  const base = { provider: 'pi' as const, workspace: root, env: {},
    payload: { session_id: 'coverage-session', turn_id: 'turn-1', timestamp: '2026-10-24T10:00:00.000Z' } }
  await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: { ...base.payload, prompt: 'change README' } })
  const open = JSON.parse(await readFile(join(recorderSessionRoot(join(root, '.scry'), 'pi', 'coverage-session'), 'open.json'), 'utf8')) as RecorderOpenTurnState
  await writeFile(join(root, 'README.md'), 'after\n')
  await handleRecorderHook({ ...base, event: 'Stop', payload: { ...base.payload,
    timestamp: '2026-10-24T10:00:01.000Z', assistant_response: 'done' } })
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  return { open, record: records[0] }
}

async function depthCheck(root: string) {
  vi.stubEnv('HOME', join(root, 'isolated-home'))
  vi.stubEnv('XDG_STATE_HOME', join(root, 'isolated-state'))
  let output = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true })
  await runScryCli(['doctor', '--workspace', root, '--json'])
  const result = JSON.parse(output) as { checks: Array<{ id: string; status: string; detail: string; remediation?: string }> }
  return result.checks.find(check => check.id === 'repositories.depth')
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('reports the depth boundary without silently increasing the default discovery depth', async () => {
  const root = await workspace()
  expect(await discoverRepositories(root, config)).toMatchObject({
    repositories: [root], maxDepth: 2, depthLimitedDirectories: 1
  })
}, 15_000)

it('honors explicit depth, exclusions and symlink boundaries without following the diagnostic probe', async () => {
  const root = await workspace()
  await symlink(join(root, 'a/b/c'), join(root, 'linked-repo'))
  expect(await discoverRepositories(root, { ...config, repositories: { mode: 'discover-nested-git', maxDepth: 3 } }, true)).toEqual({
    repositories: [root, join(root, 'a/b/c')], maxDepth: 3, depthLimitedDirectories: 0,
    nextDepth: { repositories: [], incomplete: false }
  })
  expect(await discoverRepositories(root, { ...config, repositories: { mode: 'discover-nested-git', exclude: ['a'] } }, true)).toEqual({
    repositories: [root], maxDepth: 2, depthLimitedDirectories: 0,
    nextDepth: { repositories: [], incomplete: false }
  })
  expect(await discoverRepositories(root, { ...config, repositories: { mode: 'discover-nested-git', maxDepth: 0 } })).toEqual({
    repositories: [root], maxDepth: 0, depthLimitedDirectories: 1
  })
}, 15_000)

it('bounds the doctor-only extra-depth scan and labels an incomplete probe', async () => {
  const root = await workspace()
  await Promise.all(Array.from({ length: 128 }, (_, i) => mkdir(join(root, 'a/b', `entry-${i}`))))
  const discovery = await discoverRepositories(root, config, true)
  expect(discovery).toMatchObject({ repositories: [root], depthLimitedDirectories: 1, nextDepth: { incomplete: true } })
  expect(discovery.nextDepth?.repositories.length).toBeLessThanOrEqual(128)
}, 15_000)

it('keeps the real stalled-closing omission without turning the depth boundary into an omission', async () => {
  const root = await workspace()
  const base = { provider: 'claude' as const, workspace: root, env: {},
    payload: { session_id: 'expired-coverage', turn_id: 'expired', prompt: 'go', timestamp: '2000-01-01T00:00:00Z' } }
  await handleRecorderHook({ ...base, event: 'UserPromptSubmit' })
  await handleRecorderHook({ ...base, event: 'SessionEnd', payload: { ...base.payload, timestamp: '2000-01-01T00:00:01Z' } })
  const openPath = join(recorderSessionRoot(join(root, '.scry'), 'claude', 'expired-coverage'), 'open.json')
  expect(JSON.parse(await readFile(openPath, 'utf8')).status).toBe('closing')
  await utimes(openPath, new Date('2000-01-01'), new Date('2000-01-01'))
  await recoverRecorder(root, {})
  const records = await listRecords(join(root, '.scry'))
  expect(records).toHaveLength(1)
  expect(records[0].diff.status).toBe('unavailable')
  expect(records[0].diff.value).toBeUndefined()
  expect(records[0].diff).toMatchObject({ discovery: { requestedRoots: [root], maxDepth: 2, depthLimitedDirectories: 1 } })
  expect(records[0].diff.omissionReason).toContain('baseline')
  expect(records[0].diff.omissionReason).not.toContain('maxDepth=2')
}, 15_000)

// VD1 option A is the user-approved specification revision: a depth boundary is
// metadata, not proof of missing diff evidence. Real Git/transcript gaps still degrade.
it('persists discovery coverage without degrading the captured diff merely for its depth boundary', async () => {
  const root = await workspace()
  const { open, record } = await recordTurn(root)
  expect(open.repositoryDiscovery).toEqual({ maxDepth: 2, depthLimitedDirectories: 1 })
  expect(record.diff).toMatchObject({
    status: 'available', quality: 'exact',
    discovery: { requestedRoots: [root], maxDepth: 2, depthLimitedDirectories: 1 },
    value: [expect.objectContaining({ repoRoot: root, status: 'captured' })]
  })
  expect(record.diff.omissionReason).toBeUndefined()
}, 15_000)

it('doctor names the repository one level beyond the boundary and recommends an explicit scope decision', async () => {
  const root = await workspace()
  const check = await depthCheck(root)
  expect(check).toMatchObject({ status: 'warn', detail: expect.stringContaining('a/b/c') })
  expect(check?.remediation).toContain('maxDepth')
  expect(check?.remediation).toContain('exclude')
}, 15_000)

it.each([
  { name: 'ordinary src/features/auth single repository', nested: false, status: 'pass' },
  { name: 'root/a/b/c/.git beyond the configured depth', nested: true, status: 'warn' }
])('$name keeps an available record and reports doctor $status', async ({ nested, status }) => {
  const root = await workspace(nested)
  const { record } = await recordTurn(root)
  expect.soft(record.diff.status).toBe('available')
  expect.soft(record.diff.omissionReason).toBeUndefined()
  expect(record.diff.discovery).toEqual({ requestedRoots: [root], maxDepth: 2, depthLimitedDirectories: 1 })
  const check = await depthCheck(root)
  expect(check?.status).toBe(status)
  if (nested) expect(check?.detail).toContain('a/b/c')
  else expect(check?.remediation).toBeUndefined()
}, 15_000)

it('passes an incomplete next-depth probe with no observed repository and discloses its limits', async () => {
  const root = await workspace(false)
  await Promise.all(Array.from({ length: 128 }, (_, i) => mkdir(join(root, 'src/features', `entry-${i}`))))
  expect(await discoverRepositories(root, config, true)).toMatchObject({
    depthLimitedDirectories: 1, nextDepth: { repositories: [], incomplete: true }
  })
  const check = await depthCheck(root)
  expect.soft(check?.status).toBe('pass')
  expect(check?.detail).toContain('probe incomplete')
  expect(check?.detail).toContain('32 directories / 128 entries')
  expect(check?.remediation).toBeUndefined()
}, 15_000)
