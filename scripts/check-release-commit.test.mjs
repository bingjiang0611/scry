import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkReleaseCommit, releaseContexts, verifyReleaseCommit } from './check-release-commit.mjs'

// Use real Git ancestry and fetch against a local upstream. Only the public URL
// identity check sees a synthetic origin URL. No network writes or dependencies.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    execFileSync(command, args, options) {
      if (command === 'git' && args.join(' ') === 'remote get-url origin') return 'https://github.com/bingjiang0611/scry.git\n'
      return actual.execFileSync(command, args, options)
    },
  }
})

const passing = releaseContexts.map(context => ({ context, state: 'success' }))
const passed = () => Response.json(passing)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function commit(cwd, message = 'fixture') {
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

let root, cwd, main, sha
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scry-release-test-'))
  main = join(root, 'upstream')
  cwd = join(root, 'candidate')
  git(root, 'init', '--initial-branch=main', main)
  sha = commit(main)
  git(root, 'clone', main, cwd)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('release commit gate', () => {
  it('accepts the exact verified SHA even if main has moved forward', async () => {
    const next = commit(main)
    const fetchStatus = vi.fn(passed)
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).resolves.toBe(sha)
    expect(git(cwd, 'rev-parse', 'origin/main')).toBe(next)
    expect(fetchStatus.mock.calls.map(([url]) => url)).toEqual([
      `https://api.github.com/repos/bingjiang0611/scry/commits/${sha}/statuses?per_page=100&page=1`,
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
    ['missing Remote status', () => Response.json([passing[0]]), /scry\/remote-g0: missing.*Re-run the original main push/],
    ['newer failure', () => Response.json([{ context: releaseContexts[0], state: 'failure' }, ...passing]), /scry\/full-suite: failure/],
  ])('fails closed on %s', async (_name, fetchStatus, message) => {
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(message)
  })

  it('reports a known verified SHA when the candidate has no record', async () => {
    const known = sha
    commit(main)
    git(cwd, 'pull', '--ff-only')
    const fetchStatus = url => url.includes(known) ? passed() : Response.json([])
    await expect(verifyReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(`Latest full-suite pass on main: ${known}`)
  })

  it('prints the gate result without blocking a dry run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchStatus = () => new Response('', { status: 503 })
    await expect(checkReleaseCommit({ cwd, fetchStatus, dryRun: true })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'))
    await expect(checkReleaseCommit({ cwd, fetchStatus })).rejects.toThrow(/HTTP 503/)
  })

  it('exits nonzero when invoked as a real release check from an unverified checkout', () => {
    const source = new URL('./check-release-commit.mjs', import.meta.url)
    const script = join(cwd, 'scripts', 'check-release-commit.mjs')
    git(cwd, 'remote', 'remove', 'origin')
    // Place the script in the actual fixture root layout. Even npm dry-run
    // config cannot disable the plain/App check.
    mkdirSync(join(cwd, 'scripts'))
    copyFileSync(source, script)
    const env = { ...process.env, npm_config_dry_run: 'true' }
    const real = spawnSync(process.execPath, [script], { encoding: 'utf8', env })
    expect(real.status).toBe(1)
    expect(real.stderr).toContain('Release refused: Release requires a clean worktree')
    const dry = spawnSync(process.execPath, [script, '--npm-publish'], { encoding: 'utf8', env })
    expect(dry.status).toBe(0)
    expect(dry.stderr).toContain('Dry run: release would be refused')
  })
})
