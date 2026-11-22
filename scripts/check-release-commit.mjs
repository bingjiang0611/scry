import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const upstream = 'bingjiang0611/scry'
const shaPattern = /^[0-9a-f]{40}$/
const workflows = {
  'scry/full-suite': '.github/workflows/ci.yml',
  'scry/remote-g0': '.github/workflows/remote-g0.yml',
}
export const releaseContexts = Object.keys(workflows)

function githubToken() {
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim()
  const result = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

function githubLookup(fetchApi, token) {
  return async (path, subject) => {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    if (token) headers.Authorization = `Bearer ${token}`
    try {
      const response = await fetchApi(`https://api.github.com/repos/${upstream}/${path}`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        const guidance = token ? 'Check that the credential can read commit statuses and Actions runs.'
          : 'No GitHub credential found; log in with gh or supply GH_TOKEN if anonymous access is limited.'
        throw new Error(`HTTP ${response.status}. ${guidance}`)
      }
      return await response.json()
    } catch (error) {
      throw new Error(`GitHub ${subject} lookup failed: ${error.message}`)
    }
  }
}

async function commitStatuses(sha, lookup) {
  const found = new Map()
  for (let page = 1; ; page++) {
    const statuses = await lookup(`commits/${sha}/statuses?per_page=100&page=${page}`, `status for ${sha}`)
    if (!Array.isArray(statuses) || statuses.length > 100) throw new Error('Invalid GitHub commit status response')
    for (const status of statuses) {
      if (typeof status?.context !== 'string' || !['success', 'failure', 'error', 'pending'].includes(status.state)) {
        throw new Error('Invalid GitHub commit status response')
      }
      // GitHub returns newest first; never let an old success mask a newer state.
      if (!found.has(status.context)) found.set(status.context, status)
    }
    if (statuses.length < 100 || releaseContexts.every(context => found.has(context))) return found
  }
}

async function unverifiedContexts(sha, lookup) {
  const statuses = await commitStatuses(sha, lookup)
  const rejected = []
  for (const context of releaseContexts) {
    const status = statuses.get(context)
    if (status?.state !== 'success') {
      rejected.push(`${context}: ${status?.state ?? 'missing'}`)
      continue
    }
    if (status.creator?.login !== 'github-actions[bot]') {
      rejected.push(`${context}: creator is not github-actions[bot]`)
      continue
    }
    // Match only status targets emitted by this repository. Never send a token to
    // a URL supplied by a status; use the numeric id in the fixed API endpoint.
    const runId = typeof status.target_url === 'string' &&
      /^https:\/\/github\.com\/bingjiang0611\/scry\/actions\/runs\/([1-9]\d*)$/.exec(status.target_url)?.[1]
    if (!runId) {
      rejected.push(`${context}: invalid Actions run URL`)
      continue
    }
    const run = await lookup(`actions/runs/${runId}`, `Actions run ${runId} for ${context}`)
    if (String(run?.id) !== runId || run.event !== 'push' || run.head_branch !== 'main' ||
        run.head_sha !== sha || run.path !== workflows[context]) {
      rejected.push(`${context}: Actions run ${runId} does not match the workflow, main push event and SHA`)
    }
  }
  return rejected
}

function gitOptions(cwd) {
  return { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
}

export function cleanReleaseHead(cwd = repoRoot) {
  const git = (...args) => execFileSync('git', args, gitOptions(cwd)).trim()
  if (git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')) {
    throw new Error('Release requires a clean worktree (including staged and untracked files)')
  }
  const sha = git('rev-parse', '--verify', 'HEAD^{commit}')
  if (!shaPattern.test(sha)) throw new Error('Git did not return a valid HEAD SHA')
  return sha
}

export async function verifyReleaseCommit({ cwd = repoRoot, fetchStatus = fetch } = {}) {
  const options = gitOptions(cwd)
  const git = (...args) => execFileSync('git', args, options).trim()
  const sha = cleanReleaseHead(cwd)
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

  const lookup = githubLookup(fetchStatus, githubToken())
  const unverified = await unverifiedContexts(sha, lookup)
  if (unverified.length) {
    let latest
    let searchError
    try {
      const recent = git('rev-list', '--first-parent', '--max-count=20', main).split('\n')
      for (const candidate of recent) {
        if (candidate === sha) continue
        if ((await unverifiedContexts(candidate, lookup)).length === 0) {
          latest = candidate
          break
        }
      }
    } catch (error) {
      searchError = error.message
    }
    const remedy = latest ? `Latest full-suite pass on main: ${latest}.` :
      `No alternative verified in the latest 20 main commits${searchError ? ` (lookup stopped: ${searchError})` : ''}.`
    throw new Error(`${sha} is not fully verified (${unverified.join(', ')}). ${remedy} Re-run the original main push runs for this SHA, or wait for a new main push to pass both. workflow_dispatch is diagnostic only and does not record statuses.`)
  }
  if (cleanReleaseHead(cwd) !== sha) throw new Error('HEAD changed during release verification')
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
  try {
    await checkReleaseCommit()
  } catch (error) {
    console.error(`Release refused: ${error.message}`)
    process.exitCode = 1
  }
}
