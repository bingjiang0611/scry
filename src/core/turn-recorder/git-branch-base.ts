import { gitCommand, snapshotGitArgs } from './git-command.js'
import { WorkspaceReadUnavailable } from './git-workspace-limits.js'
import type { GitTurnDiffCapture } from './git-capture.js'
import type { BranchDiffComparison } from '../../shared/workspace-diff.js'

/** Resolve only local refs; this preview never fetches or executes repository code. */
export async function resolveBranchDiffBase(capture: GitTurnDiffCapture, deadline: number): Promise<BranchDiffComparison> {
  const head = capture.head!
  const branch = capture.branch ?? null
  if (!branch) return { baseRef: null, baseCommit: head, headRef: null }
  const options = { cwd: capture.repoRoot!, deadline, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }
  const [output, configured] = await Promise.all([
    gitCommand(snapshotGitArgs([], ['for-each-ref', '--count=1001', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads', 'refs/remotes']), options),
    gitCommand(['config', '--get', `branch.${branch}.gh-merge-base`], { ...options, allowExitOne: true })
  ])
  const rows = output.trim().split('\n').filter(Boolean)
  if (rows.length > 1000) throw new WorkspaceReadUnavailable('workspace_limit')
  const refs = new Map(rows.map(row => {
    const [name, oid, symbolic] = row.split('\0')
    return [name, { oid, symbolic }]
  }))
  const remoteNames = [...new Set([...refs.keys()].filter(ref => ref.startsWith('refs/remotes/')).map(ref => ref.split('/')[2]))]
  const remote = remoteNames.includes('origin') ? 'origin' : remoteNames.length === 1 ? remoteNames[0] : undefined
  const defaultRef = remote && refs.get(`refs/remotes/${remote}/HEAD`)?.symbolic
  const defaultBranch = defaultRef?.slice(`refs/remotes/${remote}/`.length)
  const explicit = configured.trim()
  const explicitRef = [explicit, `refs/heads/${explicit}`, `refs/remotes/${explicit}`].find(ref => refs.has(ref))
  const candidates = explicitRef ? [explicitRef] : []
  for (const name of [defaultBranch, 'main', 'master']) {
    if (!name) continue
    if (remote) candidates.push(`refs/remotes/${remote}/${name}`)
    if (name !== branch) candidates.push(`refs/heads/${name}`)
  }
  const baseRef = candidates.find(ref => refs.has(ref))
  // Like T3, a repository without a comparison branch uses the observed HEAD.
  // Expose that absence instead of labelling this as a comparison against main.
  if (!baseRef) return { baseRef: null, baseCommit: head, headRef: branch }
  const baseCommit = (await gitCommand(snapshotGitArgs([], [
    'merge-base', '--end-of-options', refs.get(baseRef)!.oid, head
  ]), options)).trim()
  if (!baseCommit) throw new Error('No common ancestor for branch comparison')
  return { baseRef: baseRef.replace(/^refs\/(heads|remotes)\//, ''), baseCommit, headRef: branch }
}
