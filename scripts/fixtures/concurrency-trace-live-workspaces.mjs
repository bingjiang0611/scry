// Seeded git workspaces for the live lane (R6.3).
//
// The App records the cwd it is given in canonical form (`app-sessions.json` on macOS holds
// `/private/tmp/...` for a `/tmp/...` workspace), and RemoteChatFoundation matches a catalog
// session by exact cwd. A lane that keeps the unresolved path therefore compares two
// different strings, the session never counts as active, Controls never reads liveRun, and a
// visit measures an empty poll. So each workspace is returned by its real path, and that one
// identity is used for start, target, session ref, provider authority and the oracle.
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function gitEnv(gitHome, tmp) {
  // Strict allowlist. A developer's GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* or a credential
  // helper must never reach the seeded workspaces, and git must not read the real HOME.
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: gitHome,
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_AUTHOR_NAME: 'scry fixture',
    GIT_AUTHOR_EMAIL: 'fixture@scry.invalid',
    GIT_COMMITTER_NAME: 'scry fixture',
    GIT_COMMITTER_EMAIL: 'fixture@scry.invalid'
  }
}

/** Canonical path of an existing directory; throws rather than returning a guess. */
export function canonicalWorkspace(path) {
  return realpathSync(path)
}

export function seedWorkspaces({ work, count, gitHome, tmp, log }) {
  const root = join(work, 'workspaces')
  mkdirSync(root, { recursive: true })
  const env = gitEnv(gitHome, tmp)
  const workspaces = []
  for (let index = 0; index < count; index++) {
    const directory = join(root, `task-${String(index).padStart(2, '0')}`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'README.md'), `# concurrency trace live task ${index}\n`)
    const git = (...args) => execFileSync('git', args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '--quiet', '--initial-branch=main')
    git('add', 'README.md')
    git('commit', '--quiet', '-m', 'seed')
    // The identity the App will record, not the path the fixture happened to build.
    workspaces.push(canonicalWorkspace(directory))
  }
  log?.('bench', `seeded ${workspaces.length} git workspaces, canonical paths under ${canonicalWorkspace(root)}`)
  return workspaces
}
