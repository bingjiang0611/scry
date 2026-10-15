import { createHash } from 'node:crypto'
import type {
  ScCommitDraft,
  ScDiff,
  ScExpected,
  ScMutation,
  ScOperation,
  ScPr,
  ScPrList,
  ScPrRef,
  ScRead,
  ScRef,
  ScRepository,
  ScReviewDraft
} from '../../shared/source-control'
import { githubRepositoryFromUrl } from '../../shared/source-control'
import { ScGit, isNotRepository, type GitIdentity } from './git'
import { ScGithub, ScGithubError, type GithubSession } from './github'
import { ScCommandError, ScProcess, scMessage } from './process'
import { ScStore, type StoredOperation } from './store'

export class SourceControlService {
  private readonly identities = new Map<string, GitIdentity>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly active = new Set<string>()
  private readonly pending = new Set<Promise<unknown>>()
  private closed = false
  readonly git: ScGit
  readonly github: ScGithub
  readonly store: ScStore

  constructor(
    private readonly options: {
      userData: string
      authorizeDirectory: (cwd: string) => string
      unsettledDirectories: () => Array<string | undefined>
      process?: ScProcess
      github?: ScGithub
    }
  ) {
    const process = options.process ?? new ScProcess()
    this.git = new ScGit(process, options.authorizeDirectory)
    this.github = options.github ?? new ScGithub(() => process.credential())
    this.store = new ScStore(options.userData)
  }

  private async identity(ref: ScRef): Promise<GitIdentity> {
    if (this.closed) throw new Error('应用正在退出，拒绝新操作')
    await this.store.ready
    const identity = this.identities.get(ref.repositoryId)
    if (!identity) throw new Error('仓库引用已过期，请重新读取工作区')
    if (
      this.options.authorizeDirectory(identity.root) !== identity.root ||
      (await this.git.identity(identity.root)).id !== identity.id
    )
      throw new Error('仓库授权或身份已改变')
    return identity
  }

  private async busy(commonDir: string): Promise<boolean> {
    for (const cwd of this.options.unsettledDirectories()) {
      if (!cwd) return true // Provider-specific default cwd is not a proved repository identity.
      try {
        if ((await this.git.identity(cwd)).commonDir === commonDir) return true
      } catch (error) {
        if (!isNotRepository(error)) throw error
      }
    }
    return false
  }

  /** Registration executes in the same tick as the mutation-gate check. */
  async admitRun(cwd: string | undefined, register: () => void): Promise<void> {
    if (this.closed) throw new Error('应用正在退出')
    if (!this.active.size) {
      register()
      return
    }
    if (!cwd) throw new Error('源代码管理写入期间，不能启动工作目录未明确的 Agent')
    let identity: GitIdentity
    try {
      identity = await this.git.identity(cwd)
    } catch (error) {
      if (isNotRepository(error)) {
        register()
        return
      }
      throw error
    }
    if (this.active.has(identity.commonDir))
      throw new Error('此仓库正在执行源代码管理操作，请等待操作完成后启动 Agent')
    register()
  }

  private exclusive<T>(identity: GitIdentity, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(identity.commonDir) ?? Promise.resolve()
    const result = previous.then(async () => {
      if (this.closed) throw new Error('应用正在退出')
      this.active.add(identity.commonDir)
      try {
        return await action()
      } finally {
        this.active.delete(identity.commonDir)
      }
    })
    const tail = result.then(
      () => {},
      () => {}
    )
    this.tails.set(identity.commonDir, tail)
    this.pending.add(result)
    void tail.then(() => {
      this.pending.delete(result)
      if (this.tails.get(identity.commonDir) === tail) this.tails.delete(identity.commonDir)
    })
    return result
  }

  async read(cwd: string): Promise<ScRead<ScRepository>> {
    try {
      await this.store.ready
      const directory = this.options.authorizeDirectory(cwd)
      const identity = await this.git.identity(directory)
      // A nested project grant does not authorize its parent Git repository.
      this.options.authorizeDirectory(identity.root)
      this.identities.set(identity.id, identity)
      const snapshot = await this.git.status(identity)
      const unknown = await this.store.unresolved(identity.commonDir)
      snapshot.writeBlocker =
        snapshot.writeBlocker ??
        (unknown
          ? '有尚未核查的操作，请先查看操作记录'
          : (await this.busy(identity.commonDir))
            ? '同一仓库的 Agent 尚未完全结束；允许查看，暂不执行 Git 写入'
            : null)
      return { status: 'available', data: snapshot }
    } catch (error) {
      return { status: isNotRepository(error) ? 'unavailable' : 'failed', reason: scMessage(error) }
    }
  }

  private async expected(identity: GitIdentity, request: ScExpected): Promise<ScRepository> {
    const snapshot = await this.git.status(identity)
    if (snapshot.revision !== request.expectedRevision)
      throw new Error('仓库已变化；重新读取并确认 HEAD、暂存区和文件范围后再操作')
    return snapshot
  }

  async diff(request: ScExpected & { path: string; staged: boolean }): Promise<ScRead<ScDiff>> {
    try {
      const identity = await this.identity(request)
      const snapshot = await this.expected(identity, request)
      const file = snapshot.files.find((file) => file.path === request.path)
      if (!file) throw new Error('该文件不属于当前 Git 快照')
      const data = await this.git.diff(identity, file, request.staged)
      await this.expected(identity, request)
      return { status: 'available', data }
    } catch (error) {
      return { status: 'failed', reason: scMessage(error) }
    }
  }

  private async githubScope(
    identity: GitIdentity,
    repository: string,
    session: GithubSession
  ): Promise<void> {
    const snapshot = await this.git.status(identity)
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

  async pullRequests(request: ScRef & { repository: string }): Promise<ScRead<ScPrList>> {
    try {
      const identity = await this.identity(request)
      const session = await this.github.connect()
      await this.githubScope(identity, request.repository, session)
      return { status: 'available', data: await session.list(request.repository) }
    } catch (error) {
      return { status: 'failed', reason: scMessage(error) }
    }
  }

  async pullRequest(request: ScPrRef): Promise<ScRead<ScPr>> {
    try {
      const identity = await this.identity(request)
      const session = await this.github.connect()
      await this.githubScope(identity, request.repository, session)
      return { status: 'available', data: await session.detail(request.repository, request.number) }
    } catch (error) {
      return { status: 'failed', reason: scMessage(error) }
    }
  }

  async mutate(request: ScMutation & { operationId: string }): Promise<ScOperation> {
    const identity = await this.identity(request)
    return this.exclusive(identity, async () => {
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
      const prior = await this.store.get(request.operationId)
      if (prior) {
        if (prior.requestHash !== requestHash || prior.operation.repositoryId !== identity.id)
          throw new Error('operation ID 已绑定另一项操作')
        return prior.operation
      }
      const blocker = (await this.store.unresolved(identity.commonDir))
        ? '此仓库或关联 worktree 有结果未知的操作；先在原工作区核查，不重放写入'
        : (await this.busy(identity.commonDir))
          ? '同仓库 Agent 尚未完全结束，不能同时修改 Git/PR 状态'
          : null
      const record: StoredOperation = {
        version: 1,
        commonDir: identity.commonDir,
        requestHash,
        intent: {},
        acknowledged: false,
        operation: {
          id: request.operationId,
          repositoryId: identity.id,
          action: request.action,
          status: blocker ? 'failed' : 'running',
          startedAt: Date.now(),
          message: blocker ?? '正在预检目标与权限'
        }
      }
      await this.store.save(record)
      if (blocker) return record.operation
      let dispatched = false
      let completionNote = ''
      try {
        if (request.action === 'review' || request.action === 'merge') {
          const session = await this.github.connect()
          await this.githubScope(identity, request.repository, session)
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
          await this.store.save(record)
          dispatched = true
          record.operation.evidence =
            request.action === 'review'
              ? { reviewId: await session.review(pr, request) }
              : { sha: await session.merge(pr, request.method) }
          if (request.action === 'review') {
            try {
              await this.store.saveDraft({
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
          const snapshot = await this.expected(identity, request)
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
            dispatched = true
            await this.git.stage(identity, files, request.action === 'unstage', snapshot.head)
            await this.git.status(identity)
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
              const previousTree = (await this.git.run(identity.root, ['write-tree'])).trim()
              record.intent = { parent: snapshot.head }
              record.operation.message = '正在暂存明确选择的文件；尚未创建提交'
              await this.store.save(record)
              dispatched = true
              const paths = await this.git.stage(identity, selected, false, snapshot.head)
              tree = (await this.git.run(identity.root, ['write-tree'])).trim()
              const changed = (await this.git.run(identity.root, [
                'diff-tree', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-commit-id',
                '--name-only', '-z', '-r', previousTree, tree
              ])).split('\0').filter(Boolean)
              if (changed.some((path) => !paths.includes(path)))
                throw new Error('暂存期间其他文件的 index 发生变化；请核查，不夹带提交或自动回滚')
              const staged = await this.git.status(identity)
              if (staged.head !== snapshot.head || staged.writeBlocker || staged.actionBlockers.commit)
                throw new Error('暂存已执行，但仓库或提交授权已变化；请核查，不自动提交或回滚')
            } else tree = (await this.git.run(identity.root, ['write-tree'])).trim()
            record.intent = {
              parent: snapshot.head,
              tree
            }
            await this.store.save(record)
            dispatched = true
            const sha = await this.git.commitIndex(identity, request.message)
            const [actualTree, parents] = (
              await this.git.run(identity.root, ['show', '--no-patch', '--format=%T%n%P', sha])
            )
              .trimEnd()
              .split('\n')
            if (actualTree !== record.intent.tree || (parents ?? '') !== (snapshot.head ?? ''))
              throw new Error('提交已经执行，但实际 tree/parent 与预检不一致；请核查，不自动回滚')
            record.operation.evidence = { sha }
            try {
              await this.store.saveCommitDraft({ repositoryId: identity.id, head: sha, message: '' })
            } catch {
              completionNote = '。提交已完成，但本机消息草稿未能清空'
            }
          } else if (request.action === 'push' || request.action === 'fetch') {
            if (!snapshot.remotes.some((remote) => remote.name === request.remote))
              throw new Error('远端不属于当前仓库')
            const target = await this.git.transportTarget(identity, request.remote, request.action)
            await this.expected(identity, request)
            if (request.action === 'push') {
              if (!snapshot.branch || !snapshot.head)
                throw new Error('detached/unborn HEAD 不能推送；请先创建分支和提交')
              const remoteHead = await this.git.remoteHead(identity, target, snapshot.branch)
              if (remoteHead)
                await this.git.run(identity.root, ['merge-base', '--is-ancestor', remoteHead, snapshot.head])
              record.intent = { target, branch: snapshot.branch, head: snapshot.head }
              await this.store.save(record)
              await this.expected(identity, request)
              dispatched = true
              await this.git.push(identity, target, snapshot.branch, snapshot.head)
              if ((await this.git.remoteHead(identity, target, snapshot.branch)) !== snapshot.head)
                throw new Error('推送已执行但远端无法确认到达预期 SHA')
              record.operation.evidence = { sha: snapshot.head }
            } else {
              record.intent = { target }
              await this.store.save(record)
              dispatched = true
              await this.git.fetch(identity, target, request.remote)
            }
          } else {
            if (!snapshot.branch || snapshot.branch !== request.headBranch || !snapshot.head)
              throw new Error('创建 PR 的源分支必须是当前已确认分支')
            if (request.headRepository.toLowerCase() === request.repository.toLowerCase() && request.headBranch === request.baseBranch)
              throw new Error('PR 源分支与目标分支相同，请先创建功能分支')
            const session = await this.github.connect()
            if (session.account !== request.account) throw new Error('GitHub 账户已变化，请重新读取')
            await this.githubScope(identity, request.repository, session)
            await this.githubScope(identity, request.headRepository, session)
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
            await this.store.save(record)
            dispatched = true
            record.operation.evidence = await session.create(request)
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
        await this.store.save(record)
      } catch {
        record.operation.status = 'unknown'
        record.operation.message = '操作可能已执行，但结果日志保存失败；请核查，不重复发送'
      }
      return record.operation
    })
  }

  async operations(ref: ScRef): Promise<ScOperation[]> {
    await this.identity(ref)
    return (await this.store.list(ref.repositoryId)).map((record) => ({
      ...record.operation,
      acknowledged: record.acknowledged
    }))
  }

  async reconcile(ref: ScRef & { operationId: string }): Promise<ScOperation> {
    const identity = await this.identity(ref)
    return this.exclusive(identity, async () => {
      const record = await this.store.get(ref.operationId)
      if (!record || record.operation.repositoryId !== identity.id) throw new Error('操作不属于此仓库')
      if (record.operation.status !== 'unknown') return record.operation
      const { intent } = record
      try {
        if (record.operation.action === 'push' && intent.branch && intent.target && intent.head) {
          const snapshot = await this.git.status(identity)
          const remote = snapshot.remotes.find(
            (remote) => remote.pushUrls.length === 1 && remote.pushUrls[0] === intent.target
          )
          if (!remote || (await this.git.transportTarget(identity, remote.name, 'push')) !== intent.target)
            throw new Error('实际 push 端点配置已改变，不能用 fetch URL 代替核查')
          if ((await this.git.remoteHead(identity, intent.target, intent.branch)) === intent.head) {
            record.operation.status = 'succeeded'
            record.operation.evidence = { sha: intent.head }
            record.operation.message = '只读核查确认：同一推送端点的分支已到达预期 SHA'
          } else record.operation.message = '远端尚不能确认为预期 SHA；保持未知，不重试'
        } else if (record.operation.action === 'commit' && intent.tree) {
          const state = await this.git.status(identity)
          if (state.head) {
            const [tree, parents] = (
              await this.git.run(identity.root, ['show', '--no-patch', '--format=%T%n%P', state.head])
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
          const session = await this.github.connect()
          if (session.account !== intent.account) throw new Error('GitHub 账户已改变')
          await this.githubScope(identity, intent.repository, session)
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
      await this.store.save(record)
      return record.operation
    })
  }

  async acknowledge(ref: ScRef & { operationId: string }): Promise<ScOperation> {
    const identity = await this.identity(ref)
    return this.exclusive(identity, async () => {
      const record = await this.store.get(ref.operationId)
      if (!record || record.operation.repositoryId !== identity.id || record.operation.status !== 'unknown')
        throw new Error('只能处理本仓库结果未知的操作')
      record.acknowledged = true
      record.operation.message = `${record.operation.message}\n用户标记已人工核查并解除阻断；结果仍为 unknown，未重试`
      await this.store.save(record)
      return { ...record.operation, acknowledged: true }
    })
  }

  private authorizeDraft(ref: ScRef): void {
    const identity = this.identities.get(ref.repositoryId)
    if (this.closed || !identity || this.options.authorizeDirectory(identity.root) !== identity.root)
      throw new Error('草稿仓库引用未授权或应用正在退出')
    // Drafts write userData only. Do not run asynchronous Git probes on every keystroke,
    // which could reorder saves; real Git/PR mutations revalidate identity independently.
  }

  async saveCommitDraft(draft: ScCommitDraft): Promise<void> {
    this.authorizeDraft(draft)
    await this.store.saveCommitDraft(draft)
  }

  async loadCommitDraft(ref: ScRef): Promise<unknown | null> {
    this.authorizeDraft(ref)
    return this.store.loadCommitDraft(ref.repositoryId)
  }

  async saveDraft(draft: ScReviewDraft): Promise<void> {
    this.authorizeDraft(draft)
    await this.store.saveDraft(draft)
  }

  async loadDraft(ref: ScPrRef): Promise<unknown | null> {
    this.authorizeDraft(ref)
    return this.store.loadDraft(ref)
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.git.process.dispose()
    await Promise.allSettled([...this.pending])
    await this.store.flushDrafts()
  }
}
