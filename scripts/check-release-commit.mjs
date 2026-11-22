import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const upstream = 'bingjiang0611/scry'
const shaPattern = /^[0-9a-f]{40}$/
export const releaseContexts = ['scry/full-suite', 'scry/remote-g0']

async function commitStatuses(sha, fetchStatus) {
  const found = new Map()
  for (let page = 1; ; page++) {
    const response = await fetchStatus(`https://api.github.com/repos/${upstream}/commits/${sha}/statuses?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`GitHub status lookup for ${sha} failed: HTTP ${response.status}`)
    const statuses = await response.json()
    if (!Array.isArray(statuses) || statuses.length > 100) throw new Error('Invalid GitHub commit status response')
    for (const status of statuses) {
      if (typeof status?.context !== 'string' || !['success', 'failure', 'error', 'pending'].includes(status.state)) {
        throw new Error('Invalid GitHub commit status response')
      }
      // GitHub returns newest first; never let an old success mask a newer state.
      if (!found.has(status.context)) found.set(status.context, status.state)
    }
    if (statuses.length < 100 || releaseContexts.every(context => found.has(context))) return found
  }
}

export async function verifyReleaseCommit({ cwd = repoRoot, fetchStatus = fetch } = {}) {
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
  const git = (...args) => execFileSync('git', args, options).trim()
  function cleanHead() {
    if (git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')) {
      throw new Error('Release requires a clean worktree (including staged and untracked files)')
    }
    const sha = git('rev-parse', '--verify', 'HEAD^{commit}')
    if (!shaPattern.test(sha)) throw new Error('Git did not return a valid HEAD SHA')
    return sha
  }
  const sha = cleanHead()
  const remote = git('remote', 'get-url', 'origin')
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)bingjiang0611\/scry(?:\.git)?\/?$/i.test(remote)) {
    throw new Error(`Release requires origin to point to github.com/${upstream}`)
  }
  const main = 'refs/remotes/origin/main'
  const deepening = git('rev-parse', '--is-shallow-repository') === 'true' ? ['--unshallow'] : []
  git('fetch', '--no-tags', ...deepening, 'origin', `+refs/heads/main:${main}`)
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, main], options)
  if (ancestor.error) throw ancestor.error
  if (ancestor.status === 1) throw new Error(`${sha} is not reachable from the latest origin/main`)
  if (ancestor.status !== 0) throw new Error(`Could not verify origin/main ancestry: ${ancestor.stderr}`)

  const statuses = await commitStatuses(sha, fetchStatus)
  const unverified = releaseContexts.filter(context => statuses.get(context) !== 'success')
  if (unverified.length) {
    let latest
    let searchError
    try {
      const recent = git('rev-list', '--first-parent', '--max-count=20', main).split('\n')
      for (const candidate of recent) {
        if (candidate === sha) continue
        const known = await commitStatuses(candidate, fetchStatus)
        if (releaseContexts.every(context => known.get(context) === 'success')) {
          latest = candidate
          break
        }
      }
    } catch (error) {
      searchError = error.message
    }
    const remedy = latest ? `Latest full-suite pass on main: ${latest}.` :
      `No alternative verified in the latest 20 main commits${searchError ? ` (lookup stopped: ${searchError})` : ''}.`
    throw new Error(`${sha} is not fully verified (${unverified.map(context => `${context}: ${statuses.get(context) ?? 'missing'}`).join(', ')}). ${remedy} Re-run the original main push runs for this SHA, or wait for a new main push to pass both. workflow_dispatch is diagnostic only and does not record statuses.`)
  }
  if (cleanHead() !== sha) throw new Error('HEAD changed during release verification')
  return sha
}

export async function checkReleaseCommit({ dryRun = false, ...options } = {}) {
  try {
    const sha = await verifyReleaseCommit(options)
    console.log(`Release commit ${sha}: both correctness statuses passed`)
    return sha
  } catch (error) {
    if (!dryRun) throw error
    console.warn(`Dry run: release would be refused: ${error.message}`)
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // npm sets the resolved publish dry-run setting for lifecycle scripts. Other
  // entry points enforce the check regardless of npm configuration.
  const dryRun = process.argv[2] === '--npm-publish' && process.env.npm_config_dry_run === 'true'
  try {
    await checkReleaseCommit({ dryRun })
  } catch (error) {
    console.error(`Release refused: ${error.message}`)
    process.exitCode = 1
  }
}
