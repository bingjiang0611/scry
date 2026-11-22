import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkReleaseCommit, releaseContexts, verifyReleaseCommit } from './check-release-commit.mjs'

// Real fetch and ancestry against a local Git repo, with synthetic remote identity and credentials.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    execFileSync(command, args, options) {
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return 'https://github.com/bingjiang0611/scry.git\n'
      return actual.execFileSync(command, args, options)
    },
    spawnSync(command, args, options) {
      if (command === 'gh') {
        expect(args).toEqual(['auth', 'token', '--hostname', 'github.com'])
        return { status: ghToken ? 0 : 1, stdout: ghToken }
      }
      return actual.spawnSync(command, args, options)
    },
  }
})

const api = 'https://api.github.com/repos/bingjiang0611/scry'
const passing = releaseContexts.map((context, index) => ({
  context, state: 'success', creator: { login: 'github-actions[bot]' },
  target_url: `https://github.com/bingjiang0611/scry/actions/runs/${101 + index}`,
}))
function runResponse(url, head = sha, overrides = {}) {
  const id = Number(url.split('/').at(-1))
  return Response.json({ id, head_sha: head, event: 'push', head_branch: 'main',
    path: id === 101 ? '.github/workflows/ci.yml' : '.github/workflows/remote-g0.yml', ...overrides })
}
const passed = url => url.includes('/actions/runs/') ? runResponse(url) : Response.json(passing)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function commit(cwd, message = 'fixture') {
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

let root, cwd, main, sha, ghToken
beforeEach(() => {
  ghToken = ''
  vi.stubEnv('GH_TOKEN', '')
  root = mkdtempSync(join(tmpdir(), 'scry-release-test-'))
  main = join(root, 'upstream')
  cwd = join(root, 'candidate')
  git(root, 'init', '--initial-branch=main', main)
  sha = commit(main)
  git(root, 'clone', main, cwd)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('release commit gate', () => {
  it('accepts the exact verified SHA even if main has moved forward', async () => {
    const next = commit(main)
    const fetchStatus = vi.fn(passed)
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).resolves.toBe(sha)
    expect(git(cwd, 'rev-parse', 'origin/main')).toBe(next)
    expect(fetchStatus.mock.calls.map(([url]) => url)).toEqual([
      `${api}/commits/${sha}/statuses?per_page=100&page=1`, `${api}/actions/runs/101`, `${api}/actions/runs/102`,
    ])
  })

  it('rejects a dirty tree or a HEAD no longer reachable from a freshly fetched main', async () => {
    const fetchStatus = vi.fn(passed)
    const file = join(cwd, 'untracked')
    writeFileSync(file, 'dirty')
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(/clean worktree/)
    git(cwd, 'add', 'untracked')
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(/clean worktree/)
    git(cwd, 'rm', '-f', 'untracked')
    git(main, 'checkout', '--orphan', 'replacement')
    expect(commit(main, 'replacement root')).not.toBe(sha)
    git(main, 'branch', '-M', 'main')
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(/not reachable/)
    expect(fetchStatus).not.toHaveBeenCalled()
  })

  it.each([
    ['network error', () => Promise.reject(new Error('offline')), /offline/],
    ['authentication error', () => new Response('', { status: 401 }), /HTTP 401/],
    ['rate limit', () => new Response('', { status: 403 }), /HTTP 403/],
    ['malformed JSON', () => new Response('not JSON'), /JSON/],
    ['malformed response', () => Response.json({ statuses: passing }), /Invalid GitHub/],
    ['malformed status', () => Response.json([...passing, { context: 'unrelated', state: 'invalid' }]), /Invalid GitHub/],
    ['missing Remote status', url => url.includes('/actions/runs/') ? runResponse(url) : Response.json([passing[0]]), /scry\/remote-g0: missing.*Re-run the original main push/],
    ['newer failure', url => url.includes('/actions/runs/') ? runResponse(url) : Response.json([{ context: releaseContexts[0], state: 'failure' }, ...passing]), /scry\/full-suite: failure/],
  ])('fails closed on %s', async (_name, fetchStatus, message) => {
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(message)
  })

  it.each([
    ['creator', { creator: { login: 'other-user' } }, /creator is not github-actions/],
    ['spoofed host', { target_url: 'https://example.invalid/bingjiang0611/scry/actions/runs/101' }, /invalid Actions run URL/],
    ['wrong repository', { target_url: 'https://github.com/other/scry/actions/runs/101' }, /invalid Actions run URL/],
    ['invalid run ID', { target_url: 'https://github.com/bingjiang0611/scry/actions/runs/not-a-run' }, /invalid Actions run URL/],
  ])('rejects a successful status with invalid %s', async (_name, override, message) => {
    const fetchStatus = vi.fn(url => url.includes('/actions/runs/') ? runResponse(url)
      : Response.json([{ ...passing[0], ...override }, passing[1]]))
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(message)
    expect(fetchStatus.mock.calls.slice(1).map(([url]) => url)).toEqual([`${api}/actions/runs/102`])
  })

  it.each([
    ['event', { event: 'pull_request' }],
    ['branch', { head_branch: 'feature' }],
    ['SHA', { head_sha: 'a'.repeat(40) }],
    ['workflow', { path: '.github/workflows/ci.yml' }],
    ['run ID', { id: 101 }],
  ])('rejects a successful Remote status with the wrong run %s', async (_name, override) => {
    const fetchStatus = url => url.endsWith('/runs/102') ? runResponse(url, sha, override) : passed(url)
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(/scry\/remote-g0: Actions run 102 does not match/)
  })

  it('rejects a failed run lookup; anonymous failures explain how to authenticate', async () => {
    const fetchStatus = url => url.endsWith('/runs/101') ? new Response('', { status: 403 }) : passed(url)
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(/run 101.*HTTP 403.*log in with gh or supply GH_TOKEN/)
  })

  it.each([
    ['GH_TOKEN', 'env-fixture-token', 'cli-fixture-token', 'env-fixture-token'],
    ['gh auth token', '', 'cli-fixture-token', 'cli-fixture-token'],
    ['anonymous', '', '', undefined],
  ])('uses %s for both status and run requests', async (_name, envToken, cliToken, expected) => {
    vi.stubEnv('GH_TOKEN', envToken)
    ghToken = cliToken
    const fetchStatus = vi.fn((url, _opts) => passed(url))
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).resolves.toBe(sha)
    expect(fetchStatus.mock.calls.map(([, opts]) => opts.headers.Authorization)).toEqual(Array(3).fill(expected && `Bearer ${expected}`))
  })

  it('reports a known verified SHA when the candidate has no record', async () => {
    const known = sha
    commit(main)
    git(cwd, 'pull', '--ff-only')
    const fetchStatus = url => url.includes('/actions/runs/') ? runResponse(url, known)
      : url.includes(known) ? Response.json(passing) : Response.json([])
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(`Latest full-suite pass on main: ${known}`)
  })

  it('prints the gate result without blocking an internal dry run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchStatus = () => new Response('', { status: 503 })
    await expect(checkReleaseCommit({ cwd, fetchStatus, dryRun: true })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'))
    await expect(checkReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(/HTTP 503/)
  })

  it('exits nonzero on an unverified checkout even with npm dry-run config', () => {
    const source = new URL('./check-release-commit.mjs', import.meta.url)
    const script = join(cwd, 'scripts', 'check-release-commit.mjs')
    mkdirSync(join(cwd, 'scripts'))
    copyFileSync(source, script)
    const env = { ...process.env, npm_config_dry_run: 'true' }
    const real = spawnSync(process.execPath, [script], { encoding: 'utf8', env })
    expect(real.status).toBe(1)
    expect(real.stderr).toContain('Release refused: Release requires a clean worktree')
  })
})
