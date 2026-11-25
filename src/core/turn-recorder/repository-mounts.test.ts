import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { discoverRepositories, parseRecorderConfig, repositoryDiscoveryStats, resetRepositoryDiscoveryStats } from './config'
import { applySessionCaptureHook, startSessionCapture } from './session-capture'
import type { SessionCaptureContext } from './session-capture-contract'
import { listRecords } from './store'

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function layout() {
  const dir = await mkdtemp(join(tmpdir(), 'scry-repo-mount-'))
  roots.push(dir)
  const base = await realpath(dir)
  const root = join(base, 'session')
  const mount = join(root, 'repos')
  const repo = join(base, 'real-repository')
  await Promise.all([mkdir(mount, { recursive: true }), mkdir(repo)])
  const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo })).stdout.trim()
  await git('init', '-b', 'mounted-branch')
  await writeFile(join(repo, '.gitignore'), '*.ignored\n')
  await writeFile(join(repo, 'tracked.txt'), 'before\n')
  await git('add', '.')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline')
  await git('remote', 'add', 'origin', 'https://example.invalid/team/mounted.git')
  const commitBefore = await git('rev-parse', 'HEAD')
  const first = join(mount, 'first')
  await Promise.all([symlink(repo, first), symlink(repo, join(mount, 'second'))])
  const config = parseRecorderConfig({ schemaVersion: 1, workspaceId: 'session',
    repositories: { mode: 'discover-nested-git' }, capture: { sessions: 'opt-in' } })
  await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
  return { root, base, mount, repo, first, commitBefore, config }
}

it('baselines a mounted repository once and records shell-only edits with its real Git identity', async () => {
  const { root, repo, first, commitBefore } = await layout()
  const transcriptPath = join(root, 'rollout.jsonl')
  const timestamp = new Date().toISOString()
  await writeFile(transcriptPath, [
    { timestamp, type: 'session_meta', payload: { id: 'fixture', cwd: root } },
    { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'test shell changes' } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  const context: SessionCaptureContext = {
    protocol: 'codelens.session-capture.v1', captureId: 'linked-fixture', sessionId: 'fixture',
    cwd: root, host: 'codex', transcriptPath, openedAt: timestamp, source: 'manual', task: 'linked'
  }
  const base = { workspace: root, dataDir: join(root, '.scry'), provider: 'codex' as const, sessionId: 'fixture', context }
  const payload = { session_id: 'fixture', transcript_path: transcriptPath, turn_id: 'turn-1', cwd: root, timestamp }
  await startSessionCapture({ ...base, payload, cli: {} })
  const command = "printf 'after\\n' > tracked.txt; printf 'new\\n' > untracked.txt; printf 'hidden\\n' > skip.ignored"
  const shell = { ...payload, tool_name: 'Bash', tool_use_id: 'shell-1', tool_input: { command } }
  await applySessionCaptureHook({ ...base, event: 'PreToolUse', payload: shell })
  await exec('/bin/sh', ['-c', command], { cwd: first })
  await applySessionCaptureHook({ ...base, event: 'PostToolUse', payload: shell })
  await applySessionCaptureHook({ ...base, event: 'Stop', payload })
  const records = await listRecords(base.dataDir)
  expect(records).toHaveLength(1)
  const { diff } = records[0]
  expect(diff.discovery?.requestedRoots).toEqual([repo])
  expect(diff.value).toHaveLength(1)
  expect(diff.value?.[0]).toMatchObject({
    repoRoot: repo, requestedRoot: repo, status: 'captured',
    repositoryLocation: { branch: 'mounted-branch', commitBefore, remote: 'example.invalid/team/mounted',
      branchStatus: 'observed', commitStatus: 'observed', remoteStatus: 'observed' }
  })
  expect(diff.value?.[0].files.map(file => [file.path, file.change])).toEqual([
    [join(repo, 'tracked.txt'), 'modified'], [join(repo, 'untracked.txt'), 'added']
  ])
})

it('skips unsafe and invalid links without inspecting their subdirectories or spending Git slots on them', async () => {
  const { root, base, mount, repo, config } = await layout()
  const notRepo = join(base, 'not-a-repo')
  await mkdir(join(notRepo, 'nested'), { recursive: true })
  await symlink(repo, join(notRepo, 'nested', 'hidden-repo'))
  await mkdir(join(base, 'node_modules'))
  await Promise.all([
    symlink('loop-b', join(mount, 'loop-a')), symlink('loop-a', join(mount, 'loop-b')),
    symlink('missing-target', join(mount, 'broken')), symlink(notRepo, join(mount, 'plain')),
    symlink(join(base, 'node_modules'), join(mount, 'dependency-alias')),
    symlink(repo, join(root, 'ordinary-alias')), symlink(repo, join(mount, 'node_modules')),
    symlink(join(repo, 'tracked.txt'), join(mount, 'file')),
    symlink('/', join(mount, 'outside')), symlink(root, join(mount, 'back-to-session'))
  ])
  resetRepositoryDiscoveryStats()
  const started = performance.now()
  await expect(discoverRepositories(root, config, false, true)).resolves.toMatchObject({ repositories: [repo] })
  expect(performance.now() - started).toBeLessThan(5_000)
  // Mounted repositories cannot fan out into sibling worktrees.
  expect(repositoryDiscoveryStats().worktreeCommands).toBe(0)
  await expect(discoverRepositories(root, config)).resolves.toMatchObject({ repositories: [] })
  await expect(discoverRepositories(root, { ...config, capture: { ...config.capture, sessions: undefined } }, false, true))
    .resolves.toMatchObject({ repositories: [] })
  await expect(discoverRepositories(root, { ...config, repositories: { ...config.repositories, maxDepth: 1 } }, false, true))
    .resolves.toMatchObject({ repositories: [] })
})
