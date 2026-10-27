import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorkspaceStartSelection, PreparedWorkspace, WorkspaceWorktreeChoice } from '../../shared/workspace-selection'
import type { GitIdentity, ScGit } from './git'
import type { WorkspacePlan } from './workspace-journal'
import { readWorktreeChoices, validateWorkspaceBranch, worktreeChoiceId } from './workspace-choices'
import { assertWorkspaceCheckoutSafe, resolveWorkspaceRef, verifyWorkspaceRef } from './workspace-git'

function requireUsableWorktree(tree: WorkspaceWorktreeChoice): void {
  if (tree.bare || tree.locked !== null || tree.prunable !== null)
    throw new Error('所选 worktree 已锁定、失效或没有工作目录；草稿保留，不会修复或清理现场')
}

async function unusedWorktreePath(userData: string, identity: GitIdentity, id: string): Promise<string> {
  const root = await realpath(userData)
  const repository = createHash('sha256').update(identity.commonDir).digest('hex')
  const parent = join(root, 'worktrees', repository)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (await realpath(parent) !== parent) throw new Error('宿主 worktree 存储目录发生符号链接重定向')
  const path = join(parent, id)
  try {
    await lstat(path)
    throw new Error('目标 worktree 路径已经存在；不会覆盖或删除')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  return path
}

export async function planWorkspace(
  git: ScGit, identity: GitIdentity, sourceCwd: string,
  selection: WorkspaceStartSelection, userData: string
): Promise<WorkspacePlan> {
  const { intent, operationId } = selection
  const source = await git.revisionSnapshot(identity)
  const worktrees = await readWorktreeChoices(git, identity)
  const current = worktrees.find(tree => tree.current)
  if (!current) throw new Error('当前工作区不在 Git worktree 清单中')
  const requireSourceReady = (): void => {
    if (!source.head) throw new Error('仓库尚无 HEAD；可以聊天，但不能创建或切换工作区')
    const blocker = source.writeBlocker ?? source.actionBlockers.prepareWorkspace
    if (blocker) throw new Error(blocker)
  }
  const fromTree = (tree: WorkspaceWorktreeChoice, cwd = tree.path): WorkspacePlan => {
    requireUsableWorktree(tree)
    return { cwd, head: tree.head, branchRef: tree.branchRef, worktreeId: tree.id, write: 'none' }
  }
  // Reusing a checkout writes nothing; verifyWorkspacePlan re-reads its identity afterwards.
  if (intent.kind === 'existingWorktree') {
    const tree = worktrees.find(tree => tree.id === intent.worktreeId)
    if (!tree) throw new Error('所选 worktree 已不存在，请重新选择')
    return fromTree(tree)
  }
  if (intent.kind === 'current' && !intent.branch) return fromTree(current, sourceCwd)
  if (intent.kind === 'newWorktree') {
    // Creating a worktree only adds a branch and a directory; it never rewrites the source
    // checkout. Guard what this write can get wrong (the base commit resolves, the new name
    // is free, the target tree has no executable filters) instead of the source snapshot,
    // which unrelated edits, staged work or commits elsewhere invalidate.
    const head = await resolveWorkspaceRef(git, identity, intent.base)
    requireSourceReady()
    await assertWorkspaceCheckoutSafe(git, identity, head)
    await validateWorkspaceBranch(git, identity, intent.newBranch)
    const branchRef = `refs/heads/${intent.newBranch}`
    if ((await git.run(identity.root, ['for-each-ref', '--count=1', '--format=%(refname)', branchRef])).trim())
      throw new Error('新分支名已存在；请选择已有分支或使用另一个名称')
    const cwd = await unusedWorktreePath(userData, identity, operationId)
    return { cwd, head, branchRef, worktreeId: worktreeChoiceId(identity.commonDir, cwd), write: 'create' }
  }
  const ref = intent.branch!
  await verifyWorkspaceRef(git, identity, ref)
  if (ref.kind !== 'local') throw new Error('远端跟踪分支只能用作新 worktree 的起点')
  const checkedOut = worktrees.filter(tree => tree.branchRef === ref.name)
  if (checkedOut.length > 1) throw new Error('此分支有多个 checkout，请明确选择已有 worktree')
  if (checkedOut.length) {
    if (checkedOut[0].head !== ref.head) throw new Error('分支 checkout 已变化，请重新读取')
    return fromTree(checkedOut[0], checkedOut[0].current ? sourceCwd : checkedOut[0].path)
  }
  // Switching rewrites the caller's own checkout, so the reviewed source snapshot must hold.
  if (source.revision !== intent.expectedRevision) throw new Error('仓库已变化，请刷新工作区选择后再发送')
  if (source.files.length) throw new Error('当前工作区有未提交改动；不能切换分支，不会 stash、reset 或搬移文件')
  requireUsableWorktree(current)
  requireSourceReady()
  await assertWorkspaceCheckoutSafe(git, identity, ref.head)
  // Keep a selected subproject's scope instead of silently starting at its parent.
  const scope = relative(identity.root, sourceCwd)
  if (scope && (isAbsolute(scope) || scope === '..' || scope.startsWith(`..${sep}`) ||
    (await git.run(identity.root, ['cat-file', '-t', `${ref.head}:${scope.split(sep).join('/')}`])).trim() !== 'tree'))
    throw new Error('目标分支没有当前项目目录，不能在切换后改用另一个 cwd')
  return { cwd: sourceCwd, head: ref.head, branchRef: ref.name, worktreeId: current.id, write: 'switch' }
}

/** Recovery metadata must still describe the originally authorized selection. */
export async function verifyWorkspaceIntent(
  source: GitIdentity, sourceCwd: string, selection: WorkspaceStartSelection,
  plan: WorkspacePlan, userData: string
): Promise<void> {
  const intent = selection.intent
  let matches: boolean
  if (intent.kind === 'existingWorktree') {
    matches = plan.write === 'none' && plan.worktreeId === intent.worktreeId
  } else if (intent.kind === 'newWorktree') {
    const parent = join(await realpath(userData), 'worktrees', createHash('sha256').update(source.commonDir).digest('hex'))
    // plan.head is the base commit this creation actually used; verifyWorkspacePlan re-reads it.
    matches = plan.write === 'create' && plan.cwd === join(parent, selection.operationId) &&
      plan.branchRef === `refs/heads/${intent.newBranch}` &&
      plan.worktreeId === worktreeChoiceId(source.commonDir, plan.cwd)
  } else if (intent.branch) {
    matches = plan.write !== 'create' && plan.branchRef === intent.branch.name && plan.head === intent.branch.head &&
      (plan.write !== 'switch' || plan.cwd === sourceCwd)
  } else {
    matches = plan.write === 'none' && plan.cwd === sourceCwd &&
      plan.worktreeId === worktreeChoiceId(source.commonDir, source.root)
  }
  if (!matches) throw new Error('恢复日志与原工作区选择不一致；不能授权或启动此目标')
}

/** Read back canonical Git facts, not just the exit status of worktree add/switch. */
export async function verifyWorkspacePlan(
  git: ScGit, source: GitIdentity, plan: WorkspacePlan, operationId: string
): Promise<PreparedWorkspace> {
  const cwd = await realpath(plan.cwd)
  if (cwd !== resolve(plan.cwd) || !(await lstat(cwd)).isDirectory()) throw new Error('目标工作区身份或目录已改变')
  const target = await git.identity(cwd)
  if (target.commonDir !== source.commonDir) throw new Error('目标 worktree 已不属于原仓库')
  const trees = await readWorktreeChoices(git, source)
  const tree = trees.find(item => item.id === plan.worktreeId)
  if (!tree || tree.path !== target.root) throw new Error('目标 worktree 登记已改变')
  requireUsableWorktree(tree)
  const state = await git.revisionSnapshot(target)
  if (state.head !== plan.head || (state.branch ? `refs/heads/${state.branch}` : null) !== plan.branchRef)
    throw new Error('准备后的目标分支或 HEAD 已变化；不会启动 Provider')
  if (state.writeBlocker) throw new Error(state.writeBlocker)
  return { operationId, repositoryId: target.id, cwd, worktreeId: tree.id, head: state.head, branchRef: tree.branchRef }
}
