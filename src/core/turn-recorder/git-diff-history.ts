import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { DIFF_COMMIT_LIMIT, DIFF_COMMIT_PAGE_SIZE, type DiffCommit, type DiffCommitPage, type DiffCommitPageRequest, type DiffCommitSnapshot, type DiffCommitSnapshotRequest, type DiffRangeRequest } from '../../shared/diff-history.js'
import type { TurnDiffSnapshot } from '../../shared/trace.js'
import { capturePathspec, cleanupCapture, type GitTurnDiffCapture } from './git-capture.js'
import { computeGitTurnDiff } from './git-compute.js'
import { gitCommand, GitDeadlineError, snapshotGitArgs, TURN_DIFF_BEGIN_DEADLINE_MS } from './git-command.js'
import { WorkspaceReadUnavailable } from './git-workspace-limits.js'

const FORMAT = '%H%x00%P%x00%s%x00%an%x00%cI%x00'
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
class InvalidDiffRange extends Error {}

function command(cwd: string, deadline: number, args: string[], allowExitOne = false): Promise<string> {
  return gitCommand(snapshotGitArgs([], ['--no-pager', ...args]), {
    cwd, deadline, allowExitOne, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }
  })
}
async function assertRange(request: DiffRangeRequest, deadline: number): Promise<void> {
  const base = (await command(request.cwd, deadline, ['merge-base', '--end-of-options', request.baseCommit, request.head], true)).trim()
  if (base !== request.baseCommit) throw new InvalidDiffRange('Comparison base is not an ancestor of the captured head')
}
function parseCommits(output: string): DiffCommit[] {
  if (Buffer.byteLength(output) > 256 * 1024) throw new WorkspaceReadUnavailable('workspace_limit')
  const fields = output.split('\0')
  const commits: DiffCommit[] = []
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const hash = fields[index].trim()
    const parents = fields[index + 1].split(' ').filter(Boolean)
    if (!SHA.test(hash) || parents.some(parent => !SHA.test(parent))) throw new Error('Invalid commit metadata')
    commits.push({ hash, parents, subject: fields[index + 2], author: fields[index + 3], committedAt: fields[index + 4] })
  }
  return commits
}

/** Anchored local history only. Neither pagination nor commit selection performs a fetch. */
export async function readDiffCommits(request: DiffCommitPageRequest, deadlineMs = TURN_DIFF_BEGIN_DEADLINE_MS): Promise<DiffCommitPage> {
  const deadline = Date.now() + deadlineMs
  try {
    const [, prefix] = await Promise.all([
      assertRange(request, deadline), command(request.cwd, deadline, ['rev-parse', '--show-prefix'])
    ])
    const pageSize = Math.min(DIFF_COMMIT_PAGE_SIZE, DIFF_COMMIT_LIMIT - request.offset)
    const output = await command(request.cwd, deadline, [
      'log', '--no-notes', '--no-show-signature', '--topo-order', `--format=${FORMAT}`,
      `--max-count=${pageSize + 1}`, `--skip=${request.offset}`, `${request.baseCommit}..${request.head}`,
      ...(prefix.replace(/\n$/, '') ? ['--', '.'] : ['--'])
    ])
    const all = parseCommits(output)
    const hasMore = all.length > pageSize
    const next = request.offset + pageSize
    return { status: 'available', commits: all.slice(0, pageSize),
      nextOffset: hasMore && next < DIFF_COMMIT_LIMIT ? next : null,
      truncated: hasMore && next >= DIFF_COMMIT_LIMIT }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof InvalidDiffRange ? 'invalid_range'
      : error instanceof GitDeadlineError ? 'deadline'
        : error instanceof WorkspaceReadUnavailable ? 'workspace_limit' : 'git_error' }
  }
}

/** Read the selected immutable commit, never today's working files or real index. */
export async function readDiffCommitSnapshot(request: DiffCommitSnapshotRequest, deadlineMs = TURN_DIFF_BEGIN_DEADLINE_MS): Promise<DiffCommitSnapshot> {
  const started = Date.now()
  const deadline = started + deadlineMs
  const collectedAt = new Date(started).toISOString()
  let capture: GitTurnDiffCapture | undefined
  let snapshot: TurnDiffSnapshot | undefined
  try {
    await assertRange(request, deadline)
    const [headAncestor, baseAncestor] = await Promise.all([
      command(request.cwd, deadline, ['merge-base', '--end-of-options', request.commit, request.head], true),
      command(request.cwd, deadline, ['merge-base', '--end-of-options', request.commit, request.baseCommit], true)
    ])
    // Membership is reachable(head) minus reachable(base), including side parents of a merge.
    if (headAncestor.trim() !== request.commit || baseAncestor.trim() === request.commit) throw new InvalidDiffRange('Commit is outside the captured range')
    const [metadata, rootPath, objectPath, tree] = await Promise.all([
      command(request.cwd, deadline, ['show', '--no-patch', '--no-notes', '--no-show-signature', `--format=${FORMAT}`, request.commit]),
      command(request.cwd, deadline, ['rev-parse', '--show-toplevel']),
      command(request.cwd, deadline, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']),
      command(request.cwd, deadline, ['rev-parse', '--verify', `${request.commit}^{tree}`])
    ])
    const commit = parseCommits(metadata)[0]
    if (!commit || commit.hash !== request.commit) throw new Error('Commit metadata unavailable')
    const repoRoot = await realpath(rootPath.replace(/\n$/, ''))
    const scope = relative(repoRoot, request.cwd) || '.'
    if (scope === '..' || scope.startsWith(`..${sep}`) || isAbsolute(scope)) throw new InvalidDiffRange('Directory is outside the repository')
    const tempDir = await mkdtemp(join(tmpdir(), 'scry-commit-diff-'))
    capture = { status: 'ready', tempDir, repoRoot, scope, head: request.commit, beforeAt: collectedAt, captureMs: 0,
      objectDir: join(tempDir, 'objects'), indexPath: join(tempDir, 'index'),
      alternateObjectDirs: [objectPath.replace(/\n$/, ''), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter),
      pathspec: capturePathspec(repoRoot, scope, []) }
    await mkdir(capture.objectDir!)
    let beforeTree = commit.parents[0]
    if (!beforeTree) {
      const options = { cwd: repoRoot, deadline, env: { ...process.env, GIT_NO_LAZY_FETCH: '1',
        GIT_INDEX_FILE: capture.indexPath, GIT_OBJECT_DIRECTORY: capture.objectDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: capture.alternateObjectDirs } }
      await gitCommand(snapshotGitArgs([], ['read-tree', '--empty']), options)
      beforeTree = (await gitCommand(snapshotGitArgs([], ['write-tree']), options)).trim()
    }
    capture.beforeTree = beforeTree
    capture.captureMs = Date.now() - started
    snapshot = await computeGitTurnDiff(capture, Math.max(0, deadline - Date.now()), { workspaceSnapshot: true }, false, {
      tree: tree.trim(), afterAt: collectedAt, indexFile: capture.indexPath!, objectDir: capture.objectDir!,
      alternateObjectDirs: capture.alternateObjectDirs, filterOverrides: []
    })
    if (snapshot.status !== 'captured') return { status: snapshot.status, reason: snapshot.reason ?? 'git_error', files: [], collectedAt }
    const revision = createHash('sha256').update(JSON.stringify([request.commit, beforeTree, capture.pathspec])).digest('hex')
    return { status: 'captured', head: request.commit, revision, collectedAt, snapshot, commit }
  } catch (error) {
    return { status: error instanceof GitDeadlineError ? 'timeout' : 'failed', files: [], collectedAt,
      reason: error instanceof GitDeadlineError ? 'deadline' : error instanceof WorkspaceReadUnavailable ? error.reason : 'git_error' }
  } finally {
    if (capture) {
      const cleanup = await cleanupCapture(capture)
      if (snapshot) snapshot.cleanup = cleanup
    }
  }
}
