import type { ScExpected, ScMutation, ScOperation, ScRepository } from '../../shared/source-control'
import type { ScGit, GitIdentity } from './git'
import { ScGithubError, type ScGithub, type GithubSession } from './github'
import { ScCommandError, scMessage } from './process'
import type { ScStore, StoredOperation } from './store'

/** Called only while SourceControlService holds the repository's commonDir gate. */
export async function executeMutation(
  request: ScMutation,
  identity: GitIdentity,
  record: StoredOperation,
  { git, github, store, expected, githubScope }: {
    git: ScGit
    github: ScGithub
    store: ScStore
    expected: (identity: GitIdentity, request: ScExpected) => Promise<ScRepository>
    githubScope: (identity: GitIdentity, repository: string, session: GithubSession) => Promise<void>
  },
  authorize?: () => void
): Promise<ScOperation> {
  let dispatched = false
  let completionNote = ''
  try {
    if (request.action === 'review' || request.action === 'merge') {
      const session = await github.connect()
      await githubScope(identity, request.repository, session)
      if (session.account !== request.account) throw new Error('GitHub 账户已变化，请重新确认')
      const pr = await session.detail(request.repository, request.number)
      if (pr.head !== request.head || pr.base !== request.base)
        throw new Error('PR 的 HEAD/base 已变化，请重新审查；旧草稿不能自动沿用')
      record.intent = {
        repository: request.repository,
        number: request.number,
        account: request.account,
        head: request.head
      }
      await store.save(record)
      authorize?.()
      dispatched = true
      record.operation.evidence =
        request.action === 'review'
          ? { reviewId: await session.review(pr, request) }
          : { sha: await session.merge(pr, request.method) }
      if (request.action === 'review') {
        try {
          await store.saveDraft({
            repositoryId: identity.id,
            repository: pr.repository,
            number: pr.number,
            account: session.account,
            head: pr.head,
            base: pr.base,
            body: '',
            verdict: 'COMMENT',
            comments: []
          })
        } catch {
          completionNote = '。审查已提交，但本机草稿未能清空；请勿重复提交'
        }
      }
    } else {
      const snapshot = await expected(identity, request)
      if (snapshot.writeBlocker) throw new Error(snapshot.writeBlocker)
      if (request.action !== 'createPr' && snapshot.actionBlockers[request.action])
        throw new Error(snapshot.actionBlockers[request.action])
      if (request.action === 'stage' || request.action === 'unstage') {
        const files = request.paths.map((path) => {
          const file = snapshot.files.find((file) => file.path === path)
          if (!file) throw new Error('暂存范围不属于当前快照')
          return file
        })
        if (
          request.action === 'stage' &&
          !request.allowStagedOverwrite &&
          files.some((file) => file.index !== '.' && !file.untracked && file.worktree !== '.')
        ) {
          throw new Error('此文件已有部分暂存；必须另行确认用完整工作区版本替换该文件的 index 选择')
        }
        authorize?.()
        dispatched = true
        await git.stage(identity, files, request.action === 'unstage', snapshot.head)
        await git.status(identity)
      } else if (request.action === 'commit') {
        const selected = (request.paths ?? []).map((path) => {
          const file = snapshot.files.find((file) => file.path === path)
          if (!file) throw new Error('提交范围不属于当前快照')
          if (!file.untracked && file.index !== '.')
            throw new Error('已有暂存内容会直接纳入提交，不能重新暂存并覆盖原有选择')
          return file
        })
        if (!selected.length && !snapshot.files.some((file) => file.index !== '.' && !file.untracked))
          throw new Error('没有已暂存内容；请选择本次要提交的文件')
        let tree: string
        if (selected.length) {
          if (snapshot.actionBlockers.stage) throw new Error(snapshot.actionBlockers.stage)
          const previousTree = (await git.run(identity.root, ['write-tree'])).trim()
          record.intent = { parent: snapshot.head }
          record.operation.message = '正在暂存明确选择的文件；尚未创建提交'
          await store.save(record)
          authorize?.()
          dispatched = true
          const paths = await git.stage(identity, selected, false, snapshot.head)
          tree = (await git.run(identity.root, ['write-tree'])).trim()
          const changed = (await git.run(identity.root, [
            'diff-tree', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-commit-id',
            '--name-only', '-z', '-r', previousTree, tree
          ])).split('\0').filter(Boolean)
          if (changed.some((path) => !paths.includes(path)))
            throw new Error('暂存期间其他文件的 index 发生变化；请核查，不夹带提交或自动回滚')
          const staged = await git.status(identity)
          if (staged.head !== snapshot.head || staged.writeBlocker || staged.actionBlockers.commit)
            throw new Error('暂存已执行，但仓库或提交授权已变化；请核查，不自动提交或回滚')
        } else tree = (await git.run(identity.root, ['write-tree'])).trim()
        record.intent = {
          parent: snapshot.head,
          tree
        }
        await store.save(record)
        authorize?.()
        dispatched = true
        const sha = await git.commitIndex(identity, request.message)
        const [actualTree, parents] = (
          await git.run(identity.root, ['show', '--no-patch', '--format=%T%n%P', sha])
        )
          .trimEnd()
          .split('\n')
        if (actualTree !== record.intent.tree || (parents ?? '') !== (snapshot.head ?? ''))
          throw new Error('提交已经执行，但实际 tree/parent 与预检不一致；请核查，不自动回滚')
        record.operation.evidence = { sha }
        try {
          await store.saveCommitDraft({ repositoryId: identity.id, head: sha, message: '' })
        } catch {
          completionNote = '。提交已完成，但本机消息草稿未能清空'
        }
      } else if (request.action === 'push' || request.action === 'fetch') {
        if (!snapshot.remotes.some((remote) => remote.name === request.remote))
          throw new Error('远端不属于当前仓库')
        const target = await git.transportTarget(identity, request.remote, request.action)
        await expected(identity, request)
        if (request.action === 'push') {
          if (!snapshot.branch || !snapshot.head)
            throw new Error('detached/unborn HEAD 不能推送；请先创建分支和提交')
          const remoteHead = await git.remoteHead(identity, target, snapshot.branch)
          if (remoteHead)
            await git.run(identity.root, ['merge-base', '--is-ancestor', remoteHead, snapshot.head])
          record.intent = { target, branch: snapshot.branch, head: snapshot.head }
          await store.save(record)
          await expected(identity, request)
          authorize?.()
          dispatched = true
          await git.push(identity, target, snapshot.branch, snapshot.head)
          if ((await git.remoteHead(identity, target, snapshot.branch)) !== snapshot.head)
            throw new Error('推送已执行但远端无法确认到达预期 SHA')
          record.operation.evidence = { sha: snapshot.head }
        } else {
          record.intent = { target }
          await store.save(record)
          authorize?.()
          dispatched = true
          await git.fetch(identity, target, request.remote)
        }
      } else {
        if (!snapshot.branch || snapshot.branch !== request.headBranch || !snapshot.head)
          throw new Error('创建 PR 的源分支必须是当前已确认分支')
        if (request.headRepository.toLowerCase() === request.repository.toLowerCase() && request.headBranch === request.baseBranch)
          throw new Error('PR 源分支与目标分支相同，请先创建功能分支')
        const session = await github.connect()
        if (session.account !== request.account) throw new Error('GitHub 账户已变化，请重新读取')
        await githubScope(identity, request.repository, session)
        await githubScope(identity, request.headRepository, session)
        const branch = await session.request<{ commit: { sha: string } }>(
          'GET',
          `/repos/${request.headRepository}/branches/${encodeURIComponent(request.headBranch)}`
        )
        if (branch.commit?.sha !== snapshot.head)
          throw new Error('GitHub 源分支不等于本地 HEAD；先推送并核实，不夹带自动推送')
        record.intent = {
          repository: request.repository,
          head: snapshot.head,
          branch: snapshot.branch,
          account: session.account
        }
        await store.save(record)
        authorize?.()
        dispatched = true
        record.operation.evidence = await session.create(request, authorize)
      }
    }
    record.operation.status = 'succeeded'
    record.operation.message = `${request.action} 已确认完成；其他步骤不会自动执行${completionNote}`
  } catch (error) {
    record.operation.status =
      !dispatched || (error instanceof ScGithubError && !error.uncertain) ? 'failed' : 'unknown'
    record.operation.message = scMessage(error)
    if (
      error instanceof ScCommandError &&
      !dispatched &&
      /ancestor|not a valid|bad object/.test(error.message)
    )
      record.operation.message = '远端与本地不能确认快进；请先 fetch 或在终端处理分叉，不强制推送'
  }
  try {
    await store.save(record)
  } catch {
    record.operation.status = 'unknown'
    record.operation.message = '操作可能已执行，但结果日志保存失败；请核查，不重复发送'
  }
  return record.operation
}
