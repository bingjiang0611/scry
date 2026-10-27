import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceBranchRef } from '../../shared/workspace-selection'
import { readConfig, readOnly, type GitIdentity, type ScGit } from './git'

/** Refs from the picker are frozen names + object identities, not revision expressions. */
export async function resolveWorkspaceRef(git: ScGit, identity: GitIdentity, ref: WorkspaceBranchRef): Promise<string> {
  const prefix = ref.kind === 'local' ? 'refs/heads/' : 'refs/remotes/'
  if (!ref.name.startsWith(prefix)) throw new Error('无效的起始分支')
  await git.run(identity.root, ['check-ref-format', ref.name])
  const actual = (await git.run(identity.root, ['rev-parse', '--verify', `${ref.name}^{commit}`])).trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(actual)) throw new Error('所选分支指向的对象不是提交')
  return actual
}

/** Switches and checkouts reuse the frozen identity; the ref must still be the reviewed commit. */
export async function verifyWorkspaceRef(git: ScGit, identity: GitIdentity, ref: WorkspaceBranchRef): Promise<void> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref.head)) throw new Error('无效的起始分支')
  if (await resolveWorkspaceRef(git, identity, ref) !== ref.head)
    throw new Error('所选分支已变化，请重新读取并确认起点')
}

/**
 * Inspect target-tree attributes with a private index. Looking only at the source
 * checkout misses filters introduced by the branch we are about to materialize.
 * Neither read-tree nor check-attr runs content filters; native write hooks are
 * separately refused by SourceControlService's action blocker.
 */
export async function assertWorkspaceCheckoutSafe(git: ScGit, identity: GitIdentity, head: string): Promise<void> {
  const tree = await git.run(identity.root, ['ls-tree', '-r', '-z', '--full-tree', head])
  const rows = tree.split('\0').filter(Boolean)
  if (rows.some(row => row.startsWith('160000 ')))
    throw new Error('目标分支包含子模块；不会自动初始化或递归执行子模块配置')
  const names = rows.map(row => row.slice(row.indexOf('\t') + 1)).join('\0')
  if (!names) return
  const directory = await mkdtemp(join(tmpdir(), 'scry-workspace-attributes-'))
  const gitIndexFile = join(directory, 'index')
  try {
    await git.process.run('git', [...readConfig, ...readOnly, 'read-tree', head], identity.root, { gitIndexFile })
    const attributes = await git.process.run('git', [
      ...readConfig, ...readOnly, 'check-attr', '--cached', '-z', '--stdin', 'filter'
    ], identity.root, { gitIndexFile, input: names + '\0' })
    const config = new Map((await git.run(identity.root, ['config', '--null', '--list', '--includes']))
      .split('\0').filter(Boolean).map(row => {
        const separator = row.indexOf('\n')
        return separator < 0 ? [row, 'true'] : [row.slice(0, separator), row.slice(separator + 1)]
      }))
    const fields = attributes.split('\0')
    for (let index = 2; index < fields.length; index += 3) {
      const driver = fields[index]
      if (driver === 'unspecified' || driver === 'unset' || driver === 'set') continue
      if (['clean', 'smudge', 'process'].some(kind => config.get(`filter.${driver}.${kind}`)) ||
        /^(?:true|yes|on|1)$/i.test(config.get(`filter.${driver}.required`) ?? ''))
        throw new Error(`目标分支需要原生 filter ${driver}；不会在准备工作区时执行该程序，请在终端处理`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function switchWorkspaceBranch(git: ScGit, identity: GitIdentity, ref: WorkspaceBranchRef): Promise<void> {
  if (ref.kind !== 'local') throw new Error('远端跟踪分支只能用作新分支的起点')
  await git.run(identity.root, [
    ...readOnly, '-c', 'submodule.recurse=false',
    'switch', '--no-guess', '--', ref.name.slice('refs/heads/'.length)
  ], false)
}

export async function createWorkspaceWorktree(
  git: ScGit, identity: GitIdentity, path: string, branch: string, head: string
): Promise<void> {
  await git.run(identity.root, [
    ...readOnly, '-c', 'submodule.recurse=false',
    'worktree', 'add', '--no-track', '-b', branch, '--', path, head
  ], false, 60_000)
}
