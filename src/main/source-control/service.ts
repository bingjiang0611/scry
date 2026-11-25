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
import type { WorkspaceChoices, WorkspaceChoicesRequest, WorkspaceStartStatus } from '../../shared/workspace-selection'
import { inspectWorkspaceStart, startWorkspace, type StartPreparedWorkspace, type WorkspaceBusyScope, type WorkspaceStartDependencies, type WorkspaceStartOptions, type WorkspaceStartRequest } from './workspace-start'
import { readWorkspaceChoices, validateWorkspaceBranch } from './workspace-choices'
import { ScGit, isNotRepository, type GitIdentity } from './git'
import { ScGithub, type GithubSession } from './github'
import { executeMutation } from './mutation'
import { assertGithubScope, reconcileUnknownOperation } from './reconcile'
import { ScProcess, scMessage } from './process'
import { ScStore, type StoredOperation } from './store'

export class SourceControlService {
  private readonly identities = new Map<string, GitIdentity>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly active = new Set<string>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly cancels = new Map<string, { repositoryId: string; controller: AbortController }>()
  private readonly workspaceCancels = new Map<string, { repositoryId: string; controller: AbortController; cancellable: boolean }>()
  private closed = false
  readonly git: ScGit
  readonly github: ScGithub
  readonly store: ScStore

  constructor(
    private readonly options: {
      userData: string
      authorizeDirectory: (cwd: string) => string
      unsettledDirectories: () => Array<string | undefined>
      registeredWorkspaceRun?: (runId: string, cwd: string) => boolean
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

  private async busy(commonDir: string, scope: WorkspaceBusyScope): Promise<boolean> {
    for (const cwd of this.options.unsettledDirectories()) {
      // A Provider-specific default cwd is not a proved repository identity, so it stays
      // conservative for every scope, including a create that touches no checkout.
      if (!cwd) return true
      try {
        const active = await this.git.identity(cwd)
        if (active.commonDir !== commonDir) continue
        if (scope.kind === 'repository' || (scope.kind === 'root' && active.root === scope.root)) return true
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

  async withCheckpointRollback<T>(cwd: string, restore: () => Promise<T>): Promise<T | undefined> {
    const identity = await this.git.identity(cwd)
    return this.exclusive(identity, async () => {
      if (await this.busy(identity.commonDir, { kind: 'root', root: identity.root })) return undefined
      return restore()
    })
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
          : (await this.busy(identity.commonDir, { kind: 'repository' }))
            ? '同一仓库的 Agent 尚未完全结束；允许查看，暂不执行 Git 写入'
            : null)
      return { status: 'available', data: snapshot }
    } catch (error) {
      return { status: isNotRepository(error) ? 'unavailable' : 'failed', reason: scMessage(error) }
    }
  }

  async workspaceChoices(request: WorkspaceChoicesRequest): Promise<ScRead<WorkspaceChoices>> {
    try {
      if (this.closed) throw new Error('应用正在退出')
      await this.store.ready
      const directory = this.options.authorizeDirectory(request.cwd)
      const identity = await this.git.identity(directory)
      this.options.authorizeDirectory(identity.root)
      this.identities.set(identity.id, identity)
      const snapshot = await this.git.revisionSnapshot(identity)
      const busyRoots = new Set<string>()
      let unknownCwd = false
      for (const cwd of new Set(this.options.unsettledDirectories())) {
        if (!cwd) {
          unknownCwd = true
          continue
        }
        try {
          if (cwd === directory || cwd === identity.root) {
            busyRoots.add(identity.root)
            continue
          }
          const active = await this.git.identity(cwd)
          if (active.commonDir === identity.commonDir) busyRoots.add(active.root)
        } catch (error) {
          if (!isNotRepository(error)) throw error
        }
      }
      const commonDirBusy = unknownCwd || busyRoots.size > 0 || this.active.has(identity.commonDir)
      if (await this.store.unresolved(identity.commonDir))
        snapshot.writeBlocker = '有尚未核查的操作，请先查看操作记录'
      return { status: 'available', data: await readWorkspaceChoices(this.git, identity, snapshot, request, {
        commonDirBusy, busyRoots, unknownCwd, recentWorktrees: await this.store.recentWorktrees(identity.commonDir)
      }) }
    } catch (error) {
      return { status: isNotRepository(error) ? 'unavailable' : 'failed', reason: scMessage(error) }
    }
  }

  async validateWorkspaceBranch(request: ScRef & { name: string }): Promise<ScRead<{ name: string }>> {
    try {
      const identity = await this.identity(request)
      await validateWorkspaceBranch(this.git, identity, request.name)
      return { status: 'available', data: { name: request.name } }
    } catch (error) {
      return { status: 'failed', reason: scMessage(error) }
    }
  }

  private workspaceDependencies(identity: GitIdentity): WorkspaceStartDependencies {
    return {
      git: this.git, store: this.store, userData: this.options.userData,
      busy: scope => this.busy(identity.commonDir, scope),
      authorize: cwd => {
        if (this.closed) throw new Error('应用正在退出')
        return this.options.authorizeDirectory(cwd)
      },
      registeredRun: (runId, cwd) => this.options.registeredWorkspaceRun?.(runId, cwd) === true
    }
  }

  async startWorkspace(
    request: WorkspaceStartRequest,
    start: StartPreparedWorkspace,
    requestedRunId?: string,
    options: Pick<WorkspaceStartOptions, 'signal' | 'onProgress'> = {}
  ) {
    const identity = await this.identity(request.workspace.intent)
    const operationId = request.workspace.operationId
    const controller = new AbortController()
    const external = options.signal
    const forwardAbort = (): void => controller.abort()
    if (external?.aborted) controller.abort()
    else external?.addEventListener('abort', forwardAbort, { once: true })
    const entry = { repositoryId: identity.id, controller, cancellable: true }
    if (!this.workspaceCancels.has(operationId)) this.workspaceCancels.set(operationId, entry)
    try {
      return await this.exclusive(identity, async () => {
        await this.identity(request.workspace.intent)
        const cwd = this.options.authorizeDirectory(request.cwd)
        if ((await this.git.identity(cwd)).id !== identity.id) throw new Error('所选仓库与发送目录不一致')
        return startWorkspace(identity, { ...request, cwd }, this.workspaceDependencies(identity), start, requestedRunId, {
          signal: controller.signal,
          onProgress: options.onProgress,
          onCancellableChange: (cancellable) => { entry.cancellable = cancellable }
        })
      })
    } finally {
      external?.removeEventListener('abort', forwardAbort)
      if (this.workspaceCancels.get(operationId) === entry) this.workspaceCancels.delete(operationId)
    }
  }

  /**
   * Cancels an in-flight workspace preparation before Provider handoff.
   * Stops only this operation's registered git child; cleanup is verified inside startWorkspace.
   */
  async cancelWorkspaceStart(ref: ScRef & { operationId: string }): Promise<boolean> {
    await this.identity(ref)
    const entry = this.workspaceCancels.get(ref.operationId)
    if (!entry || entry.repositoryId !== ref.repositoryId || !entry.cancellable) return false
    entry.cancellable = false
    entry.controller.abort()
    return true
  }

  async inspectWorkspaceStart(ref: ScRef & { operationId: string }): Promise<ScRead<WorkspaceStartStatus | null>> {
    try {
      const identity = await this.identity(ref)
      return await this.exclusive(identity, async () => {
        const record = await this.store.get(ref.operationId)
        if (!record) return { status: 'available', data: null }
        return { status: 'available', data: await inspectWorkspaceStart(identity, record, this.workspaceDependencies(identity)) }
      })
    } catch (error) {
      return { status: 'failed', reason: scMessage(error) }
    }
  }

  private assertRevision(current: string, expected: string): void {
    if (current !== expected)
      throw new Error('仓库已变化；重新读取并确认 HEAD、暂存区和文件范围后再操作')
  }

  private async expected(identity: GitIdentity, request: ScExpected): Promise<ScRepository> {
    const snapshot = await this.git.status(identity)
    this.assertRevision(snapshot.revision, request.expectedRevision)
    return snapshot
  }

  async diff(request: ScExpected & { path: string; staged: boolean }): Promise<ScRead<ScDiff>> {
    try {
      const identity = await this.identity(request)
      const expected = async () => {
        const snapshot = await this.git.revisionSnapshot(identity)
        this.assertRevision(snapshot.revision, request.expectedRevision)
        return snapshot
      }
      const snapshot = await expected()
      const file = snapshot.files.find((file) => file.path === request.path)
      if (!file) throw new Error('该文件不属于当前 Git 快照')
      const data = await this.git.diff(identity, file, request.staged)
      await expected()
      return { status: 'available', data }
    } catch (error) {
      return { status: 'failed', reason: scMessage(error) }
    }
  }

  private githubScope(identity: GitIdentity, repository: string, session: GithubSession): Promise<void> {
    return assertGithubScope(this.git, identity, repository, session)
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

  async mutate(request: ScMutation & { operationId: string }, authorize?: () => void): Promise<ScOperation> {
    const identity = await this.identity(request)
    const cancellable = request.action === 'push' || request.action === 'fetch'
    const controller = cancellable && !this.cancels.has(request.operationId) ? new AbortController() : null
    if (controller) this.cancels.set(request.operationId, { repositoryId: identity.id, controller })
    try {
      return await this.mutateExclusive(request, identity, controller?.signal, authorize)
    } finally {
      if (controller && this.cancels.get(request.operationId)?.controller === controller) this.cancels.delete(request.operationId)
    }
  }

  /**
   * Cancels a running push or fetch of this repository. It only aborts the operation's
   * own registered git child (see ScProcess); the operation then records failed if
   * nothing was sent yet, or unknown if the write had started. Returns false when
   * there is nothing to cancel (already finished, another repository, or not cancellable).
   */
  async cancel(ref: ScRef & { operationId: string }): Promise<boolean> {
    await this.identity(ref)
    const entry = this.cancels.get(ref.operationId)
    if (!entry || entry.repositoryId !== ref.repositoryId) return false
    entry.controller.abort()
    return true
  }

  private async mutateExclusive(request: ScMutation & { operationId: string }, identity: GitIdentity, signal: AbortSignal | undefined, authorize?: () => void): Promise<ScOperation> {
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
        : (await this.busy(identity.commonDir, { kind: 'repository' }))
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
      return executeMutation(request, identity, record, {
        git: this.git,
        github: this.github,
        store: this.store,
        expected: (target, expected) => this.expected(target, expected),
        githubScope: (target, repository, session) => this.githubScope(target, repository, session),
        ...(signal ? { signal } : {})
      }, authorize)
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
      return reconcileUnknownOperation(identity, record, {
        git: this.git,
        github: this.github,
        store: this.store,
        githubScope: (target, repository, session) => this.githubScope(target, repository, session),
        workspaceDependencies: (target) => this.workspaceDependencies(target)
      })
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
