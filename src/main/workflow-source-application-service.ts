import { createHash } from 'node:crypto'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'
import type { WorkflowSourceApplicationCatalog, WorkflowSourceApplicationCommand, WorkflowSourceApplicationReceipt, WorkflowSourceApplicationReview } from '../shared/workflow-source-application'
import type { WorkflowStore } from './workflow-store'
import type { WorkflowSystemHost } from './workflow-system-host'
import { WorkflowSourceApplicationController } from './workflow-source-application'
import { WorkflowSourceApplicationStore } from './workflow-source-application-store'
import { WorkflowSourceApplicationResolver, type ResolvedWorkflowSourceApplication } from './workflow-source-application-resolution'
import { applyWorkflowCandidateTree, workflowSourceChangedPaths, workflowSourceSnapshot, workflowSourceTrustFingerprint } from './source-control/apply-workflow-candidate'
import { bindWorkflowCheck, executeWorkflowCheck } from './workflow-check'

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class WorkflowSourceApplicationService {
  private readonly receipts: WorkflowSourceApplicationStore
  private readonly resolver: WorkflowSourceApplicationResolver
  private readonly controller: WorkflowSourceApplicationController
  private readonly systems: WorkflowSystemHost
  private readonly resolveWorkspace: (workspace: string) => string | Promise<string>

  constructor(deps: {
    userData: string
    store: WorkflowStore
    systems: WorkflowSystemHost
    resolveWorkspace: (workspace: string) => string | Promise<string>
  }) {
    this.receipts = new WorkflowSourceApplicationStore(deps.userData)
    this.resolver = new WorkflowSourceApplicationResolver(deps.store, deps.systems.replicas)
    this.systems = deps.systems
    this.resolveWorkspace = deps.resolveWorkspace
    const authorize = async (workspace: string) => {
      const resolved = await deps.resolveWorkspace(workspace)
      if (resolved !== workspace) throw new Error('源码工作区授权已变化')
      return { trustFingerprint: await workflowSourceTrustFingerprint(resolved) }
    }
    const runCheck = async (_workspace: string, frozen: WorkflowFrozenCheck): Promise<'passed' | 'failed' | 'unknown'> => {
      const execution = executeWorkflowCheck(frozen, deps.systems.checkEnvironment()), result = await execution.result
      if (!result.settled || result.state === 'unknown' || result.state === 'incomplete') return 'unknown'
      await execution.settled
      return result.state === 'passed' ? 'passed' : 'failed'
    }
    this.controller = new WorkflowSourceApplicationController(this.receipts, {
      authorize,
      sourceState: async workspace => ({ hash: (await workflowSourceSnapshot(workspace)).hash, trustFingerprint: (await authorize(workspace)).trustFingerprint }),
      candidateState: async workspace => ({ hash: (await workflowSourceSnapshot(workspace)).hash }),
      check: runCheck,
      apply: applyWorkflowCandidateTree
    })
  }

  async catalog(workflowId: string, programRevision: string): Promise<WorkflowSourceApplicationCatalog> {
    const targets = await this.resolver.targets(workflowId, programRevision), items: WorkflowSourceApplicationReview[] = [], receipts = await this.receipts.list(workflowId, programRevision)
    const terminalTargets = new Set(receipts.filter(receipt => receipt.state !== 'rejected').map(receipt => `${receipt.target.workflowRevision}:${receipt.target.stepId}:${receipt.target.nodeId}`))
    for (const target of targets) {
      if (terminalTargets.has(`${target.workflowRevision}:${target.stepId}:${target.nodeId}`)) continue
      const resolved = await this.resolver.resolve(workflowId, programRevision, target.stepId)
      const review = await this.review(resolved)
      if (review.changedPaths.length) items.push(review)
    }
    const revision = items[0]?.workflowRevision ?? targets[0]?.workflowRevision ?? 0
    return { workflowId, programRevision, workflowRevision: revision, reviewedAt: Date.now(), items, receipts }
  }

  async apply(command: WorkflowSourceApplicationCommand): Promise<WorkflowSourceApplicationReceipt> {
    if (!command.confirmation.acknowledgesSourceMutation || !command.confirmation.acknowledgesNoAutomaticRollback) throw new Error('必须明确确认源码写入和无自动回滚')
    const admissionFingerprint = fingerprint({ target: command.target, expected: command.expected, confirmation: command.confirmation })
    const prior = await this.receipts.load(command.operationId)
    if (prior) {
      if (prior.admissionFingerprint !== admissionFingerprint) throw new Error('源码应用操作标识已用于其他请求')
      return prior
    }
    const resolved = await this.resolver.resolve(command.target.workflowId, command.target.programRevision, command.target.stepId)
    if (JSON.stringify(resolved.target) !== JSON.stringify(command.target) || (resolved.record.progress.revision ?? 0) !== command.target.workflowRevision) throw new Error('源码应用目标已变化')
    const review = await this.review(resolved)
    if (review.baseHash !== command.expected.baseHash || review.candidateHash !== command.expected.candidateHash || review.trustFingerprint !== command.expected.trustFingerprint) throw new Error('源码应用预览已变化')
    const lease = await this.resolver.acquire(resolved.candidate)
    try {
      // The resolver validated the immutable receipt; this lease serializes
      // against replica cleanup while the controller rechecks and applies it.
      return await this.applyResolved(command, resolved, review, admissionFingerprint, lease.directory)
    } finally { lease.release() }
  }

  private async applyResolved(command: WorkflowSourceApplicationCommand, resolved: ResolvedWorkflowSourceApplication, review: WorkflowSourceApplicationReview,
    admissionFingerprint: string, candidateWorkspace: string): Promise<WorkflowSourceApplicationReceipt> {
    const candidateCheck = bindWorkflowCheck(resolved.frozenCheck, resolved.candidateReceipt, this.systems.checkEnvironment()).check
    return this.controller.apply({ operationId: command.operationId, target: command.target, admissionFingerprint, workspace: resolved.sourceWorkspace, candidateWorkspace,
      baseHash: review.baseHash, candidateHash: review.candidateHash, candidateCheck, sourceCheck: resolved.frozenCheck, trustFingerprint: review.trustFingerprint })
  }

  private async review(resolved: ResolvedWorkflowSourceApplication): Promise<WorkflowSourceApplicationReview> {
    const workspace = await this.resolveWorkspace(resolved.sourceWorkspace)
    if (workspace !== resolved.sourceWorkspace) throw new Error('源码工作区授权已变化')
    const [source, candidate, trustFingerprint] = await Promise.all([
      workflowSourceSnapshot(workspace), workflowSourceSnapshot(resolved.candidateReceipt.directory), workflowSourceTrustFingerprint(workspace)
    ])
    if (candidate.hash !== resolved.checkedCandidateHash) throw new Error('源码应用候选已偏离持久化检查输入')
    return { ...resolved.target, baseHash: source.hash, candidateHash: candidate.hash, trustFingerprint,
      changedPaths: workflowSourceChangedPaths(source.entries, candidate.entries), check: 'recorded_passed' }
  }
}
