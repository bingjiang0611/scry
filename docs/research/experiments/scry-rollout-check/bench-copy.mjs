import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argv, now } from './bench-args.mjs'
import { run, tryRun, turn } from './bench-util.mjs'

// ---------- copy of the source repository ----------
const MARKER = join('.git', 'scry-perf-bench-copy')
function prepareCopy(source, work) {
  source = realpathSync(source)
  if (!existsSync(join(source, '.git'))) throw new Error(`${source} is not a Git checkout root`)
  if (statSync(join(source, '.git')).isFile()) throw new Error(`${source} is a linked worktree; its copy would share the original index. Use the main checkout or a fresh clone.`)
  const target = resolve(work)
  if (target === source || target.startsWith(source + '/')) throw new Error('--work must be outside --source')
  if (existsSync(target)) {
    if (!existsSync(join(target, MARKER))) throw new Error(`${target} exists and was not created by perf-bench; pick an empty path`)
  } else {
    mkdirSync(target, { recursive: true })
    const started = now()
    // Clone entry by entry so the source's `.scry` (records, sockets) is never copied. APFS clone
    // (copy-on-write) on macOS, reflink where supported elsewhere; a silent full copy of a large
    // tree is refused unless asked for.
    for (const entry of readdirSync(source)) {
      if (entry === '.scry') continue
      const args = platform() === 'darwin' ? ['-cR', join(source, entry), target] : ['-a', '--reflink=auto', join(source, entry), target]
      const attempt = spawnSync('cp', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      if (attempt.status !== 0) {
        if (!argv.includes('--allow-full-copy')) throw new Error(`clone of ${entry} failed (${String(attempt.stderr).trim().slice(0, 200)}); rerun with --allow-full-copy to copy it fully`)
        cpSync(join(source, entry), join(target, entry), { recursive: true })
      }
    }
    writeFileSync(join(target, MARKER), JSON.stringify({ source, copiedAt: new Date().toISOString(), copyMs: Math.round(now() - started) }))
  }
  // A nested repository whose `.git` is a file (linked worktree, absorbed submodule) points at a git
  // directory. If that directory is outside the copy, git commands in the copy (the dirty scenario
  // edits and restores files) would write the source's index. Refuse instead.
  const outside = []
  for (const repo of nestedRepositories(target)) {
    const dotgit = join(repo, '.git')
    if (!statSync(dotgit).isFile()) continue
    const line = readFileSync(dotgit, 'utf8').split('\n').find((l) => l.startsWith('gitdir:'))
    const gitdir = line && resolve(repo, line.slice('gitdir:'.length).trim())
    if (!gitdir || gitdir !== target && !gitdir.startsWith(target + '/')) outside.push(`${relative(target, repo)} -> ${gitdir ?? 'unreadable'}`)
  }
  if (outside.length) throw new Error(`nested repositories in the copy point at git directories outside it (worktrees or external git dirs); git in the copy would change the source:\n  ${outside.join('\n  ')}\nUse a source whose nested repositories are plain clones or submodules with relative git dirs.`)
  // The copy must not inherit the source's recorder data or upload configuration.
  forceRemove(join(target, '.scry'))
  const config = join(target, 'scry.config.json')
  if (existsSync(config)) {
    const value = JSON.parse(readFileSync(config, 'utf8'))
    delete value.commitHook
    delete value.dataDir
    writeFileSync(config, JSON.stringify(value, null, 2) + '\n')
  }
  if (tryRun('git', ['-C', target, 'remote', 'get-url', 'origin']) !== undefined)
    run('git', ['-C', target, 'remote', 'set-url', 'origin', `git@perf-bench.invalid:scry-perf-bench/${basename(source)}.git`])
  return target
}

const DIRTY_EXCLUDE = /^(scry\.config\.json|\.scry\/|\.qoder\/|\.codex\/|\.opencode\/|\.claude\/)/
function trackedSmall(repo, limit) {
  return run('git', ['-C', repo, 'ls-files', '-z']).split('\0')
    .filter((f) => f && !DIRTY_EXCLUDE.test(f) && /\.(ts|tsx|js|mjs|md|json|py|go|rs|java|kt|swift|c|cc|cpp|h|txt)$/.test(f))
    .filter((f) => { try { return statSync(join(repo, f)).size < 200_000 } catch { return false } }).slice(0, limit)
}
function nestedRepositories(work) {
  return (tryRun('find', [work, '-mindepth', '2', '-maxdepth', '5', '-name', '.git', '-not', '-path', '*/node_modules/*', '-not', '-path', `${work}/.git/*`]) ?? '')
    .split('\n').filter(Boolean).map((g) => dirname(g)).sort()
}

// Root: up to 20 tracked files modified + 50 new files. Nested repositories (if any): one tracked
// file modified in each of the first 3, so their diffs are part of the measured and checked work.
function dirtyTree(work) {
  const files = trackedSmall(work, 20)
  const nested = nestedRepositories(work).slice(0, 3).map((repo) => ({ repo, files: trackedSmall(repo, 1) })).filter((n) => n.files.length)
  const scratch = join(work, 'scry-perf-bench-scratch')
  return {
    modified: files.length,
    nested: nested.length,
    label: `dirty (${files.length} modified + 50 new files${nested.length ? ` + ${nested.length} nested repos` : ''})`,
    apply() {
      for (const f of files) appendFileSync(join(work, f), '\n// scry perf bench\n')
      for (const n of nested) for (const f of n.files) appendFileSync(join(n.repo, f), '\n// scry perf bench\n')
      mkdirSync(scratch, { recursive: true })
      for (let i = 0; i < 50; i++) writeFileSync(join(scratch, `f${i}.txt`), `bench ${i}\n`.repeat(50))
    },
    restore() {
      if (files.length) run('git', ['-C', work, 'checkout', '--', ...files])
      for (const n of nested) run('git', ['-C', n.repo, 'checkout', '--', ...n.files])
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

// Evidence check: the dirty turn's record, normalised (copy root replaced, timestamps, ids and
// durations dropped, keys sorted), hashed. A candidate must produce the same digest as the base:
// a speed-up that changes what the record says is not a speed-up.
function processUsage(pid) {
  const out = tryRun('ps', ['-o', 'rss=,time=', '-p', String(pid)])
  if (!out) return undefined
  const [rss, time] = out.trim().split(/\s+/)
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
  const seconds = Number(days) * 86400 + clock.split(':').map(Number).reduce((acc, v) => acc * 60 + v, 0)
  return { rssMiB: Math.round(Number(rss) / 1024), cpuSeconds: seconds }
}

function cloneTree(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  const args = platform() === 'darwin' ? ['-cR', from, to] : ['-a', '--reflink=auto', from, to]
  if (spawnSync('cp', args, { stdio: 'ignore' }).status !== 0) cpSync(from, to, { recursive: true })
}

function forceRemove(path) {
  if (!existsSync(path)) return
  spawnSync('chmod', ['-R', 'u+rwX', path], { stdio: 'ignore' })
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function worktreeState(work) {
  return tryRun('git', ['-C', work, 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
}

export { MARKER, prepareCopy, DIRTY_EXCLUDE, trackedSmall, nestedRepositories, dirtyTree, processUsage, cloneTree, forceRemove, worktreeState }
