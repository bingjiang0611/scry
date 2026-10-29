import { createHash } from 'node:crypto'
import type {
  WorkspaceBranchChoice, WorkspaceBranchRef, WorkspaceChoices, WorkspaceChoicesRequest, WorkspaceWorktreeChoice
} from '../../shared/workspace-selection'
import type { GitIdentity, ScGit } from './git'

const pageSize = 100
const inventoryLimit = 1_000

export function worktreeChoiceId(commonDir: string, path: string): string {
  return createHash('sha256').update(JSON.stringify([commonDir, path])).digest('hex').slice(0, 24)
}

/** Git's -z format preserves spaces, newlines and quoted-looking directory names. */
export function parseWorktreeChoices(raw: string, identity: GitIdentity): WorkspaceWorktreeChoice[] {
  const result: WorkspaceWorktreeChoice[] = []
  let item: WorkspaceWorktreeChoice | undefined
  for (const field of raw.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (result.length >= inventoryLimit) throw new Error('Worktree 清单超过 1,000 项，请在终端处理')
      const path = field.slice('worktree '.length)
      item = {
        id: worktreeChoiceId(identity.commonDir, path), path,
        branchRef: null, head: null, current: path === identity.root,
        busy: false, bare: false, locked: null, prunable: null
      }
      result.push(item)
    } else if (item) {
      if (field.startsWith('HEAD ')) item.head = /^0+$/.test(field.slice(5)) ? null : field.slice(5)
      else if (field.startsWith('branch ')) item.branchRef = field.slice(7)
      else if (field === 'bare') item.bare = true
      else if (field === 'locked' || field.startsWith('locked ')) item.locked = field.slice(7)
      else if (field === 'prunable' || field.startsWith('prunable ')) item.prunable = field.slice(9)
    }
  }
  return result
}

export async function readWorktreeChoices(git: ScGit, identity: GitIdentity): Promise<WorkspaceWorktreeChoice[]> {
  return parseWorktreeChoices(await git.run(identity.root, ['worktree', 'list', '--porcelain', '-z']), identity)
}

async function readDefaultBase(git: ScGit, identity: GitIdentity): Promise<WorkspaceBranchRef | undefined> {
  const raw = (await git.run(identity.root, [
    'for-each-ref', '--count=1', '--format=%(refname)%00%(objectname)', 'refs/remotes/origin/main'
  ])).trim()
  if (!raw) return undefined
  const [name, head] = raw.split('\0')
  return name && head ? { name, head, kind: 'remote' } : undefined
}

export async function validateWorkspaceBranch(git: ScGit, identity: GitIdentity, name: string): Promise<void> {
  // --branch additionally rejects leading '-' and reserved checkout shorthand. Do not
  // let @{-n} expand to a previously checked-out branch and masquerade as the typed name.
  if (!name || name.length > 240 || name !== name.trim() || name.includes('@{'))
    throw new Error('请输入不超过 240 个字符的普通 Git 分支名')
  await git.run(identity.root, ['check-ref-format', '--branch', name])
}

async function readBranches(
  git: ScGit, identity: GitIdentity, query: string, worktrees: WorkspaceWorktreeChoice[]
): Promise<{ items: WorkspaceBranchChoice[]; limited: boolean }> {
  // Search is applied by Git before the count cap, not to only the first page.
  const literal = query.replace(/[\\*?\[\]]/g, '\\$&')
  const patterns = query
    ? ['refs/heads', 'refs/remotes'].flatMap(prefix => [
      `${prefix}/**/*${literal}*`, `${prefix}/**/*${literal}*/**`
    ])
    : ['refs/heads', 'refs/remotes']
  const raw = await git.run(identity.root, [
    'for-each-ref', '--sort=refname', `--count=${inventoryLimit + 1}`,
    '--format=%(refname)%00%(objectname)%00%(symref)', ...patterns
  ])
  const records = raw.trimEnd().split('\n').filter(Boolean)
  const items: WorkspaceBranchChoice[] = []
  for (const record of records.slice(0, inventoryLimit)) {
    const [name, head, symbolic] = record.split('\0')
    if (symbolic) continue // origin/HEAD is an alias, not a branch selection.
    if (!name || !head || !name.includes(query)) continue
    items.push({
      name, head, kind: name.startsWith('refs/heads/') ? 'local' : 'remote',
      worktreeIds: worktrees.filter((tree) => tree.branchRef === name).map((tree) => tree.id)
    })
  }
  return { items, limited: records.length > inventoryLimit }
}

export async function readWorkspaceChoices(
  git: ScGit,
  identity: GitIdentity,
  snapshot: Awaited<ReturnType<ScGit['revisionSnapshot']>>,
  request: WorkspaceChoicesRequest,
  activity: { commonDirBusy: boolean; busyRoots: ReadonlySet<string>; unknownCwd: boolean; recentWorktrees?: string[] }
): Promise<WorkspaceChoices> {
  const [worktrees, defaultBase] = await Promise.all([
    readWorktreeChoices(git, identity),
    readDefaultBase(git, identity)
  ])
  const recent = new Map((activity.recentWorktrees ?? []).map((id, index) => [id, index]))
  worktrees.sort((a, b) => (recent.get(a.id) ?? recent.size) - (recent.get(b.id) ?? recent.size))
  for (const tree of worktrees) tree.busy = activity.unknownCwd || activity.busyRoots.has(tree.path)
  const query = request.query?.trim() ?? ''
  const entries = request.kind === 'branches'
    ? await readBranches(git, identity, query, worktrees)
    : {
      items: worktrees.filter((tree) => `${tree.path}\n${tree.branchRef ?? ''}`.includes(query)),
      limited: false
    }
  const pageRevision = createHash('sha256').update(JSON.stringify([
    snapshot.revision, request.kind, query, request.selectedWorktreeId, entries, worktrees, activity.commonDirBusy
  ])).digest('hex').slice(0, 24)
  if (request.cursor && request.cursor.revision !== pageRevision)
    throw new Error('工作区清单已变化，请从第一页重新读取')
  const offset = request.cursor?.offset ?? 0
  const pageItems = entries.items.slice(offset, offset + pageSize)
  const result: WorkspaceChoices = {
    repositoryId: identity.id, root: identity.root, revision: snapshot.revision,
    branch: snapshot.branch, head: snapshot.head, dirty: snapshot.files.length > 0,
    writeBlocker: snapshot.writeBlocker, commonDirBusy: activity.commonDirBusy,
    observedAt: Date.now(),
    ...(defaultBase ? { defaultBase } : {}),
    ...(request.selectedWorktreeId ? { selectedWorktree: worktrees.find(tree => tree.id === request.selectedWorktreeId) } : {}),
    page: request.kind === 'branches'
      ? { kind: 'branches', items: pageItems as WorkspaceBranchChoice[] }
      : { kind: 'worktrees', items: pageItems as WorkspaceWorktreeChoice[] },
    nextCursor: offset + pageSize < entries.items.length
      ? { revision: pageRevision, offset: offset + pageSize } : null,
    limited: entries.limited
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024)
    throw new Error('工作区清单响应超过 256 KiB，请缩小搜索范围')
  return result
}
