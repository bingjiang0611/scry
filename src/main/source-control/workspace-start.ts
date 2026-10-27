import { createHash, randomUUID } from 'node:crypto'
import type { AgentStartResult, NormalizedAgentStartRequest } from '../../shared/runtime'
import type { PreparedWorkspace, WorkspaceStartSelection, WorkspaceStartStatus } from '../../shared/workspace-selection'
import type { GitIdentity, ScGit } from './git'
import { scMessage } from './process'
import type { ScStore, StoredOperation } from './store'
import { assertWorkspaceJournal, type WorkspaceJournal } from './workspace-journal'
import { planWorkspace, verifyWorkspaceIntent, verifyWorkspacePlan } from './workspace-plan'
import { createWorkspaceWorktree, switchWorkspaceBranch } from './workspace-git'

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

export interface WorkspaceStartDependencies {
  git: ScGit
  store: ScStore
  userData: string
  busy: (root?: string) => Promise<boolean>
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

/** The caller owns SourceControlService.exclusive for the entire awaited function. */
export async function startWorkspace(
  identity: GitIdentity, request: WorkspaceStartRequest,
  deps: WorkspaceStartDependencies, start: StartPreparedWorkspace
): Promise<AgentStartResult> {
  const { workspace: selection } = request
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
  let preparedThisCall: PreparedWorkspace | undefined
  try {
    const targetIdentity = journal.plan.write === 'create' && journal.phase === 'planned'
      ? undefined : await deps.git.identity(journal.plan.cwd)
    if (await deps.busy(journal.phase === 'planned' && journal.plan.write !== 'none' ? undefined : targetIdentity?.root))
      throw new Error('目标工作区或同一仓库的 Git 写入仍被运行/收口占用；草稿已保留')
    if (journal.phase === 'planned') {
      if (journal.plan.write !== 'none') {
        journal.phase = 'git_requested'
        record.operation.message = 'Git 准备已派发；结果未知时不重试'
        await save(deps.store, record)
        if (journal.plan.write === 'create') {
          await createWorkspaceWorktree(deps.git, identity, journal.plan.cwd,
            journal.plan.branchRef!.slice('refs/heads/'.length), journal.plan.head!)
        } else {
          await switchWorkspaceBranch(deps.git, identity, {
            kind: 'local', name: journal.plan.branchRef!, head: journal.plan.head!
          })
        }
      }
      preparedThisCall = await verifyWorkspacePlan(deps.git, identity, journal.plan, selection.operationId)
      journal.prepared = preparedThisCall
      journal.phase = 'prepared'
      record.operation.message = '工作区已确认；正在重验 authority、trust 与基线，Provider 尚未启动'
      await save(deps.store, record)
    }
    // 刚刚在本调用内验证过的结果直接复用：中间只有日志写入与 Provider 启动，没有 Git 写入；
    // 登记前仍会在 admit 里重验一次，所以并没有放宽最后一道检查。
    const target = preparedThisCall ?? await verifyWorkspacePlan(deps.git, identity, journal.plan, selection.operationId)
    const runId = `run-workspace-${randomUUID()}`
    const result = await start(target, runId, async register => {
      if (admissionCalled) throw new Error('工作区预留只能登记一个 run')
      admissionCalled = true
      await verifyWorkspacePlan(deps.git, identity, journal.plan, selection.operationId)
      if (await deps.busy((await deps.git.identity(target.cwd)).root)) throw new Error('登记前目标工作区已被占用')
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
    await save(deps.store, record)
    return { ...result, workspace: target }
  } catch (error) {
    if (error instanceof JournalPersistenceError) throw error
    if (!registrationDispatched && journal.phase === 'start_requested') {
      journal.phase = 'prepared'
      delete journal.launch
    }
    record.operation.status = registrationDispatched || journal.phase === 'git_requested' ? 'unknown' : 'failed'
    record.operation.message = `${scMessage(error)}${journal.phase === 'prepared' ? '；已准备的工作区保留，再次发送将复用它' : ''}`
    await save(deps.store, record)
    throw error
  }
}
