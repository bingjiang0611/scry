import { createHash, randomUUID } from 'node:crypto'
import type { AgentStartResult, NormalizedAgentStartRequest } from '../../shared/runtime'
import {
  WORKSPACE_START_CANCELLED_CODE,
  type PreparedWorkspace,
  type WorkspaceCheckoutProgress,
  type WorkspacePrepareProgress,
  type WorkspacePrepareStage,
  type WorkspaceStartSelection,
  type WorkspaceStartStatus
} from '../../shared/workspace-selection'
import type { GitIdentity, ScGit } from './git'
import { scMessage } from './process'
import type { ScStore, StoredOperation } from './store'
import { assertWorkspaceJournal, type WorkspaceJournal } from './workspace-journal'
import { planWorkspace, verifyWorkspaceIntent, verifyWorkspacePlan } from './workspace-plan'
import { cleanupAbortedWorkspaceWorktree, createWorkspaceWorktree, switchWorkspaceBranch } from './workspace-git'

export class WorkspaceStartCancelledError extends Error {
  readonly code = WORKSPACE_START_CANCELLED_CODE
  constructor(message = '已取消创建 worktree') {
    super(`${WORKSPACE_START_CANCELLED_CODE}:${message}`)
  }
}

export interface WorkspaceStartOptions {
  signal?: AbortSignal
  onProgress?: (progress: WorkspacePrepareProgress) => void
  onCancellableChange?: (cancellable: boolean) => void
}

export type WorkspaceStartRequest = NormalizedAgentStartRequest & {
  workspace: WorkspaceStartSelection
  cwd: string
  commandId: string
}

export type StartPreparedWorkspace = (
  workspace: PreparedWorkspace,
  runId: string,
  /** Only this host callback may bridge the held commonDir reservation to runs.register. */
  admit: (register: () => void) => Promise<void>
) => Promise<AgentStartResult>

/**
 * How far an unsettled run reaches into a planned write. A run whose cwd cannot be
 * resolved to a repository blocks every scope, because it cannot be proved unrelated.
 * `repository` matches the source-control panel's own mutations; `root` is one worktree.
 */
export type WorkspaceBusyScope =
  | { kind: 'repository' }
  | { kind: 'unknownCwd' }
  | { kind: 'root'; root: string }

export interface WorkspaceStartDependencies {
  git: ScGit
  store: ScStore
  userData: string
  busy: (scope: WorkspaceBusyScope) => Promise<boolean>
  authorize: (cwd: string) => string
  registeredRun: (runId: string, cwd: string) => boolean
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
class JournalPersistenceError extends Error {}

async function save(store: ScStore, record: StoredOperation): Promise<void> {
  try {
    await store.save(record)
  } catch (error) {
    // Do not repeat an uncertain journal write or dispatch the next business step.
    throw new JournalPersistenceError(`准备日志未能确认保存；请只读核查，不重复发送：${scMessage(error)}`)
  }
}

export function workspaceStartStatus(record: StoredOperation): WorkspaceStartStatus {
  const journal = record.intent.workspace
  assertWorkspaceJournal(journal)
  return {
    operation: { ...record.operation, acknowledged: record.acknowledged },
    phase: journal.phase,
    ...(journal.prepared ? { workspace: journal.prepared } : {}),
    ...(journal.launch ? { runId: journal.launch.runId, commandId: journal.launch.commandId } : {})
  }
}

/** Read-only Git/registry reconciliation. Never invokes the start callback or a Git write. */
export async function inspectWorkspaceStart(
  identity: GitIdentity, record: StoredOperation, deps: WorkspaceStartDependencies
): Promise<WorkspaceStartStatus> {
  const journal = record.intent.workspace
  assertWorkspaceJournal(journal)
  if (record.commonDir !== identity.commonDir || record.operation.repositoryId !== identity.id ||
    record.operation.action !== 'prepareWorkspace') throw new Error('准备操作不属于此仓库')
  if (journal.phase === 'git_requested') {
    try {
      journal.prepared = await verifyWorkspacePlan(deps.git, identity, journal.plan, record.operation.id)
    } catch (error) {
      return { ...workspaceStartStatus(record), operation: {
        ...record.operation, status: 'unknown', message: `目标尚未确认，不能重复创建或切换：${scMessage(error)}`
      } }
    }
    journal.phase = 'prepared'
    record.operation.status = 'failed'
    record.operation.message = '只读核查已确认工作区准备完成；Provider 尚未启动，再次发送只复用此目标'
    await save(deps.store, record)
  } else if (journal.phase === 'start_requested' && journal.prepared && journal.launch &&
    deps.registeredRun(journal.launch.runId, journal.prepared.cwd)) {
    journal.phase = 'registered'
    record.operation.status = 'succeeded'
    record.operation.message = '只读核查确认原 run 已登记；不会再启动一轮'
    await save(deps.store, record)
  }
  return workspaceStartStatus(record)
}

const MAX_PROGRESS_DETAILS = 40
const CHECKOUT_EMIT_INTERVAL_MS = 80

function createWorkspaceProgressReporter(
  identity: GitIdentity,
  selection: WorkspaceStartSelection,
  onProgress?: (progress: WorkspacePrepareProgress) => void
) {
  if (!onProgress || selection.intent.kind !== 'newWorktree') {
    return {
      stage: (_stage: WorkspacePrepareStage, _patch?: Partial<Pick<WorkspacePrepareProgress, 'workspacePrepared' | 'checkout' | 'cancellable' | 'message'>>, _detail?: string) => {},
      detail: (_line: string) => {},
      checkout: (_progress: WorkspaceCheckoutProgress) => {}
    }
  }
  const branch = selection.intent.newBranch
  const baseRef = selection.intent.base.name.replace(/^refs\/(heads|remotes)\//, '')
  let currentStage: WorkspacePrepareStage = 'preparing'
  let workspacePrepared = false
  let checkout: WorkspaceCheckoutProgress | undefined
  let cancellable = true
  let message: string | undefined
  const details: string[] = []
  let lastCheckoutEmitAt = 0
  let lastCheckoutPercent = -1

  const pushDetail = (line: string | undefined): void => {
    const clean = line?.trim()
    if (!clean) return
    const bounded = scMessage(clean).slice(0, 300)
    if (details[details.length - 1] === bounded) return
    details.push(bounded)
    if (details.length > MAX_PROGRESS_DETAILS) details.splice(0, details.length - MAX_PROGRESS_DETAILS)
  }

  const emit = (): void => {
    try {
      onProgress({
        operationId: selection.operationId,
        repositoryId: identity.id,
        stage: currentStage,
        workspacePrepared,
        ...(checkout ? { checkout: { ...checkout } } : {}),
        cancellable,
        details: [...details],
        branch,
        baseRef,
        ...(message ? { message } : {}),
        updatedAt: Date.now()
      })
    } catch { /* progress observer failures must never abort workspace preparation */ }
  }

  return {
    stage(
      next: WorkspacePrepareStage,
      patch: Partial<Pick<WorkspacePrepareProgress, 'workspacePrepared' | 'checkout' | 'cancellable' | 'message'>> = {},
      detail?: string
    ): void {
      currentStage = next
      if (patch.workspacePrepared !== undefined) workspacePrepared = patch.workspacePrepared
      if (patch.checkout !== undefined) checkout = patch.checkout
      if (patch.cancellable !== undefined) cancellable = patch.cancellable
      if (patch.message !== undefined) message = patch.message
      pushDetail(detail)
      emit()
    },
    detail(line: string): void {
      const before = details.length
      pushDetail(line)
      if (details.length !== before) emit()
    },
    checkout(next: WorkspaceCheckoutProgress): void {
      checkout = next
      const now = Date.now()
      const first = lastCheckoutPercent < 0
      const finished = next.percent >= 100
      if (first || finished || (next.percent !== lastCheckoutPercent && now - lastCheckoutEmitAt >= CHECKOUT_EMIT_INTERVAL_MS)) {
        lastCheckoutEmitAt = now
        lastCheckoutPercent = next.percent
        emit()
      }
    }
  }
}

/** The caller owns SourceControlService.exclusive for the entire awaited function. */
export async function startWorkspace(
  identity: GitIdentity, request: WorkspaceStartRequest,
  deps: WorkspaceStartDependencies, start: StartPreparedWorkspace, requestedRunId?: string,
  options: WorkspaceStartOptions = {}
): Promise<AgentStartResult> {
  const { workspace: selection } = request
  const progress = createWorkspaceProgressReporter(identity, selection, options.onProgress)
  if (options.signal?.aborted) {
    progress.stage('cancelled', { cancellable: false, message: '已取消创建 worktree' }, '在执行前已取消')
    throw new WorkspaceStartCancelledError('在执行前已取消')
  }
  const requestHash = digest({ selection, cwd: request.cwd, providerId: request.providerId, agentProfileId: request.agentProfileId })
  // Hash the normalized, bounded payload once; do not persist prompt/attachment bodies in the Git journal.
  const launchHash = digest({ ...request, commandId: undefined })
  let record = await deps.store.get(selection.operationId)
  if (record && (record.requestHash !== requestHash || record.operation.repositoryId !== identity.id ||
    record.commonDir !== identity.commonDir || record.operation.action !== 'prepareWorkspace'))
    throw new Error('操作标识已用于另一个工作区请求；不会复用或覆盖原结果')
  if (await deps.store.unresolved(identity.commonDir, selection.operationId))
    throw new Error('同一仓库有未确认操作，请先只读核查')
  if (record) {
    assertWorkspaceJournal(record.intent.workspace)
    await verifyWorkspaceIntent(identity, request.cwd, selection, record.intent.workspace.plan, deps.userData)
    await inspectWorkspaceStart(identity, record, deps)
    const prior = record.intent.workspace!
    if (prior.phase === 'registered') {
      if (prior.launch?.requestHash !== launchHash) throw new Error('这个工作区准备请求已经启动了另一条消息；请保留当前草稿并查看原 run')
      return { runId: prior.launch.runId, workspace: prior.prepared! }
    }
    if (prior.phase === 'git_requested' || prior.phase === 'start_requested')
      throw new Error('先前准备或启动的结果仍未知；只允许核查，不会重新派发')
  }
  progress.stage('preparing', { workspacePrepared: false, cancellable: true },
    selection.intent.kind === 'newWorktree'
      ? `准备分支 ${selection.intent.newBranch}（基准 ${selection.intent.base.name.replace(/^refs\/(heads|remotes)\//, '')}）`
      : undefined)
  if (!record || record.intent.workspace?.phase === 'planned') {
    const plan = await planWorkspace(deps.git, identity, request.cwd, selection, deps.userData)
    record = {
      version: 1, commonDir: identity.commonDir, requestHash, acknowledged: false,
      operation: {
        id: selection.operationId, repositoryId: identity.id, action: 'prepareWorkspace',
        status: 'running', startedAt: record?.operation.startedAt ?? Date.now(), message: '准备工作区，尚未执行 Git 写入'
      },
      intent: { workspace: { phase: 'planned', plan } }
    }
    await save(deps.store, record)
  }
  const journal: WorkspaceJournal = record.intent.workspace!
  let registered = false
  let registrationDispatched = false
  let admissionCalled = false
  let createdThisCall = false
  let preparedThisCall: PreparedWorkspace | undefined
  try {
    if (options.signal?.aborted) throw new WorkspaceStartCancelledError()
    const createAtPlanned = journal.phase === 'planned' && journal.plan.write === 'create'
    const targetIdentity = createAtPlanned ? undefined : await deps.git.identity(journal.plan.cwd)
    // Wait only for runs this write can actually collide with. A create adds a branch and a
    // directory and rewrites no existing checkout, so runs in other worktrees must not hold it
    // back; Scry still serializes its own Git writes through the commonDir reservation. A switch
    // rewrites the checkout it planned for, and a reuse must not double-drive the worktree it
    // starts in.
    if (await deps.busy(createAtPlanned ? { kind: 'unknownCwd' } : { kind: 'root', root: targetIdentity!.root }))
      throw new Error('目标工作区或同一仓库的 Git 写入仍被运行/收口占用；草稿已保留')
    if (options.signal?.aborted) throw new WorkspaceStartCancelledError()
    if (journal.phase === 'planned') {
      if (journal.plan.write !== 'none') {
        journal.phase = 'git_requested'
        record.operation.message = 'Git 准备已派发；结果未知时不重试'
        await save(deps.store, record)
        if (journal.plan.write === 'create') {
          createdThisCall = true
          progress.detail(`目标目录 ${journal.plan.cwd}`)
          await createWorkspaceWorktree(deps.git, identity, journal.plan.cwd,
            journal.plan.branchRef!.slice('refs/heads/'.length), journal.plan.head!, {
              signal: options.signal,
              onMetadataReady: () => {
                progress.stage('checking_out', { workspacePrepared: true, cancellable: true }, '工作区元数据已创建，开始检出文件')
              },
              onCheckoutProgress: (checkout) => progress.checkout(checkout),
              onDetail: (line) => progress.detail(line)
            })
        } else {
          await switchWorkspaceBranch(deps.git, identity, {
            kind: 'local', name: journal.plan.branchRef!, head: journal.plan.head!
          })
        }
      }
      if (options.signal?.aborted) throw new WorkspaceStartCancelledError()
      progress.stage('verifying', { workspacePrepared: true, cancellable: true }, '正在校验 worktree 与目标分支')
      preparedThisCall = await verifyWorkspacePlan(deps.git, identity, journal.plan, selection.operationId)
      if (options.signal?.aborted) throw new WorkspaceStartCancelledError()
      journal.prepared = preparedThisCall
      journal.phase = 'prepared'
      record.operation.message = '工作区已确认；正在重验 authority、trust 与基线，Provider 尚未启动'
      await save(deps.store, record)
    }
    if (options.signal?.aborted) throw new WorkspaceStartCancelledError()
    // 刚刚在本调用内验证过的结果直接复用：中间只有日志写入与 Provider 启动，没有 Git 写入；
    // 登记前仍会在 admit 里重验一次，所以并没有放宽最后一道检查。
    const target = preparedThisCall ?? await verifyWorkspacePlan(deps.git, identity, journal.plan, selection.operationId)
    if (options.signal?.aborted) throw new WorkspaceStartCancelledError()
    options.onCancellableChange?.(false)
    progress.stage('verifying', { workspacePrepared: true, cancellable: false }, '工作区已就绪，正在启动会话')
    const runId = requestedRunId ?? `run-workspace-${randomUUID()}`
    const result = await start(target, runId, async register => {
      if (admissionCalled) throw new Error('工作区预留只能登记一个 run')
      admissionCalled = true
      await verifyWorkspacePlan(deps.git, identity, journal.plan, selection.operationId)
      // 上一行的 verifyWorkspacePlan 已经证明 realpath(plan.cwd) === target.root，所以这里直接用
      // target.cwd 作为 root 判定占用，不再为一个字符串多解析一次仓库身份。
      if (await deps.busy({ kind: 'root', root: target.cwd })) throw new Error('登记前目标工作区已被占用')
      journal.launch = { commandId: request.commandId, requestHash: launchHash, runId }
      journal.phase = 'start_requested'
      record!.operation.status = 'running'
      record!.operation.message = '启动意图已保存；等待 run 登记，不重复启动'
      await save(deps.store, record!)
      // Synchronous authority recheck and registration: no await may open a gap here.
      if (deps.authorize(target.cwd) !== target.cwd) throw new Error('登记前工作区授权已变化')
      registrationDispatched = true
      register()
      registered = true
    })
    if (!registered || result.runId !== runId) throw new Error('启动回调未登记预留的 run；不能宣称启动成功')
    journal.phase = 'registered'
    record.operation.status = 'succeeded'
    record.operation.message = '工作区与新 run 已绑定；Provider 的执行结果由该轮记录证明'
    try {
      await save(deps.store, record)
    } catch (error) {
      if (!(error instanceof JournalPersistenceError)) throw error
      // start_requested was durably saved before synchronous registration. The
      // Provider run is now authoritative; read-only inspection can reconcile
      // this bookkeeping write without replaying Git or Provider work.
      console.warn('[scry] workspace registration journal remains recoverable:', error.message)
    }
    progress.stage('completed', { workspacePrepared: true, cancellable: false })
    return { ...result, workspace: target }
  } catch (error) {
    if (error instanceof JournalPersistenceError) throw error
    if (options.signal?.aborted && !registrationDispatched && journal.phase !== 'start_requested') {
      options.onCancellableChange?.(false)
      if (createdThisCall && journal.plan.write === 'create' && journal.plan.branchRef && journal.plan.head) {
        progress.stage('cancelling', { cancellable: false }, '正在中止并清理未完成的 worktree…')
        const cleanup = await cleanupAbortedWorkspaceWorktree(
          deps.git, identity, journal.plan.cwd, journal.plan.branchRef, journal.plan.head, deps.userData
        )
        if (cleanup.cleaned) {
          journal.phase = 'planned'
          delete journal.prepared
          record.operation.status = 'failed'
          record.operation.message = '已取消创建 worktree；未留残留目录或分支'
          await save(deps.store, record)
          progress.stage('cancelled', { cancellable: false, message: record.operation.message }, '已清理未完成的 worktree 与新建分支')
          throw new WorkspaceStartCancelledError()
        }
        journal.phase = 'git_requested'
        delete journal.prepared
        record.operation.status = 'unknown'
        record.operation.message = `已中止创建 worktree，但未能确认清理干净（${cleanup.reason}）；请先只读核查`
        await save(deps.store, record)
        progress.stage('failed', { cancellable: false, message: record.operation.message }, cleanup.reason)
        throw new Error(record.operation.message)
      }
      record.operation.status = 'failed'
      record.operation.message = '已取消创建 worktree；尚未执行 Git 写入'
      await save(deps.store, record)
      progress.stage('cancelled', { cancellable: false, message: record.operation.message })
      throw new WorkspaceStartCancelledError()
    }
    if (!registrationDispatched && journal.phase === 'start_requested') {
      journal.phase = 'prepared'
      delete journal.launch
    }
    record.operation.status = registrationDispatched || journal.phase === 'git_requested' ? 'unknown' : 'failed'
    record.operation.message = `${scMessage(error)}${journal.phase === 'prepared' ? '；已准备的工作区保留，再次发送将复用它' : ''}`
    await save(deps.store, record)
    progress.stage('failed', { cancellable: false, message: record.operation.message })
    throw error
  }
}
