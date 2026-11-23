import { githubRepositoryFromUrl, type ScOperation } from '../../shared/source-control'
import type { GitIdentity, ScGit } from './git'
import type { GithubSession, ScGithub } from './github'
import { scMessage } from './process'
import type { ScStore, StoredOperation } from './store'
import { inspectWorkspaceStart, type WorkspaceStartDependencies } from './workspace-start'

export async function assertGithubScope(
  git: ScGit,
  identity: GitIdentity,
  repository: string,
  session: GithubSession
): Promise<void> {
  const snapshot = await git.status(identity)
  const known = new Set(
    snapshot.remotes
      .flatMap((remote) => [...remote.pushUrls, ...remote.fetchUrls].map(githubRepositoryFromUrl))
      .filter((value): value is string => value !== null)
  )
  if (known.has(repository)) return
  for (const candidate of known) {
    if ((await session.metadata(candidate)).parent?.full_name === repository) return
  }
  throw new Error(
    'GitHub 仓库不属于此项目的可验证 remote/fork；SSH alias 或自定义映射尚不可用，请在 GitHub 操作'
  )
}

export interface ReconcileDependencies {
  git: ScGit
  github: ScGithub
  store: ScStore
  githubScope: (identity: GitIdentity, repository: string, session: GithubSession) => Promise<void>
  workspaceDependencies: (identity: GitIdentity) => WorkspaceStartDependencies
}

export async function reconcileUnknownOperation(
  identity: GitIdentity,
  record: StoredOperation,
  deps: ReconcileDependencies
): Promise<ScOperation> {
  if (record.operation.status !== 'unknown') return record.operation
  if (record.operation.action === 'prepareWorkspace')
    return (await inspectWorkspaceStart(identity, record, deps.workspaceDependencies(identity))).operation
  const { intent } = record
  try {
    if (record.operation.action === 'push' && intent.branch && intent.target && intent.head) {
      const snapshot = await deps.git.status(identity)
      const remote = snapshot.remotes.find(
        (remote) => remote.pushUrls.length === 1 && remote.pushUrls[0] === intent.target
      )
      if (!remote || (await deps.git.transportTarget(identity, remote.name, 'push')) !== intent.target)
        throw new Error('实际 push 端点配置已改变，不能用 fetch URL 代替核查')
      if ((await deps.git.remoteHead(identity, intent.target, intent.branch)) === intent.head) {
        record.operation.status = 'succeeded'
        record.operation.evidence = { sha: intent.head }
        record.operation.message = '只读核查确认：同一推送端点的分支已到达预期 SHA'
      } else record.operation.message = '远端尚不能确认为预期 SHA；保持未知，不重试'
    } else if (record.operation.action === 'commit' && intent.tree) {
      const state = await deps.git.status(identity)
      if (state.head) {
        const [tree, parents] = (
          await deps.git.run(identity.root, ['show', '--no-patch', '--format=%T%n%P', state.head])
        )
          .trimEnd()
          .split('\n')
        if (tree === intent.tree && (parents ?? '') === (intent.parent ?? '')) {
          record.operation.status = 'succeeded'
          record.operation.evidence = { sha: state.head }
          record.operation.message = '只读核查确认：HEAD 的 tree/parent 与预期提交一致'
        } else record.operation.message = 'HEAD 已变化，无法归因原提交；保持未知'
      }
    } else if (record.operation.action === 'merge' && intent.repository && intent.number) {
      const session = await deps.github.connect()
      if (session.account !== intent.account) throw new Error('GitHub 账户已改变')
      await deps.githubScope(identity, intent.repository, session)
      const pr = await session.request<{
        merged: boolean
        head: { sha: string }
        merge_commit_sha: string | null
      }>('GET', `/repos/${intent.repository}/pulls/${intent.number}`)
      if (pr.merged && pr.head.sha === intent.head && pr.merge_commit_sha) {
        record.operation.status = 'succeeded'
        record.operation.evidence = { sha: pr.merge_commit_sha }
        record.operation.message = '只读核查确认：预期 PR HEAD 已合并'
      } else record.operation.message = '尚不能确认预期 HEAD 已合并；保持未知'
    } else
      record.operation.message =
        '无法用只读证据唯一确认此操作；请在 Git/GitHub 人工核查。不会重新创建 PR、评论或审查'
  } catch (error) {
    record.operation.message = `核查未完成：${scMessage(error)}`
  }
  await deps.store.save(record)
  return record.operation
}
