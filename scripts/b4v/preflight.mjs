// Checks that must hold before any App is launched. A failed required check stops every
// scenario with that reason instead of letting them fail one by one for the same cause.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { electronExecutable } from './app.mjs'

export function gitState(root) {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim().length > 0
    const committedAt = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim()) * 1000
    return { commit, dirty, committedAt }
  } catch (error) {
    return { commit: null, error: String(error?.message ?? error) }
  }
}

export function preflightChecks(root, { platform = process.platform, env = process.env, git = gitState(root) } = {}) {
  const checks = []
  const check = (id, ok, detail, required = true) => checks.push({ id, ok: Boolean(ok), required, detail })
  check('platform-supported', platform === 'darwin' || platform === 'linux', platform)
  const outputs = ['out/main/index.js', 'out/main/daemon.js', 'out/main/daemon-supervisor.js', 'out/preload/index.cjs']
  const missing = outputs.filter((path) => !existsSync(join(root, path)))
  check('build-present', missing.length === 0, missing.length ? { missing, fix: 'npm run build' } : outputs)
  const executable = electronExecutable(root, platform)
  check('electron-present', existsSync(executable), executable)
  if (existsSync(executable)) {
    // The daemon runs on the App's own Electron as Node; a better-sqlite3 built for plain
    // Node fails here exactly as the daemon would, before any scenario mistakes it for a bug.
    const probe = spawnSync(executable, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], {
      cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000
    })
    check('sqlite-electron-abi', probe.status === 0,
      probe.status === 0 ? 'better-sqlite3 loads under Electron' : { stderr: String(probe.stderr ?? '').slice(-400), fix: 'npx electron-builder install-app-deps (or npx @electron/rebuild -f -w better-sqlite3)' })
  }
  if (platform === 'linux') check('display-available', Boolean(env.DISPLAY || env.WAYLAND_DISPLAY), { DISPLAY: env.DISPLAY ?? null, WAYLAND_DISPLAY: env.WAYLAND_DISPLAY ?? null, fix: 'run under a display (or xvfb-run -a)' })
  const index = join(root, 'out/main/index.js')
  if (existsSync(index) && git.committedAt) {
    const builtAt = statSync(index).mtimeMs
    // Advisory: a build older than HEAD's commit may not be the code being judged.
    check('build-newer-than-head', builtAt >= git.committedAt, { builtAt: new Date(builtAt).toISOString(), committedAt: new Date(git.committedAt).toISOString(), dirty: git.dirty }, false)
  }
  return checks
}
