import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { WorkflowFrozenCheck } from '../shared/workflow-check'

export type WorkflowSourceApplicationState = 'applied' | 'rejected' | 'partial' | 'unknown'
export type WorkflowSourceApplicationRequest = Readonly<{
  operationId: string
  workspace: string
  candidateWorkspace: string
  baseHash: string
  candidateHash: string
  frozenCheck: WorkflowFrozenCheck
  trustFingerprint: string
}>
export type WorkflowSourceApplicationReceipt = Readonly<{
  operationId: string
  requestFingerprint: string
  state: WorkflowSourceApplicationState
  requestedAt: number
  baseHash: string
  candidateHash: string
  trustFingerprint: string
  changedPaths?: readonly string[]
  reason?: string
}>

type SourceState = Readonly<{ hash: string; trustFingerprint: string }>
type Persistence = { load: (operationId: string) => Promise<WorkflowSourceApplicationReceipt | undefined>; save: (receipt: WorkflowSourceApplicationReceipt) => Promise<void> }
type Dependencies = {
  authorize: (workspace: string) => Promise<{ trustFingerprint: string }>
  state: (workspace: string) => Promise<SourceState>
  check: (workspace: string, frozen: WorkflowFrozenCheck) => Promise<'passed' | 'failed' | 'unknown'>
  conflict?: (workspace: string, candidateWorkspace: string) => Promise<boolean>
  apply: (workspace: string, candidateWorkspace: string) => Promise<{ state: 'applied' | 'partial'; changedPaths: string[] }>
}

export async function sourceWorkspaceHash(root: string): Promise<string> {
  const entries: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.git' || name === '.scry') continue
      const path = join(directory, name), info = await lstat(path), key = relative(root, path)
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) entries.push(`${key}\0${createHash('sha256').update(await readFile(path)).digest('hex')}`)
      else throw new Error('workspace contains unsupported entry')
    }
  }
  await visit(root)
  return createHash('sha256').update(entries.join('\0')).digest('hex')
}

function requestFingerprint(request: WorkflowSourceApplicationRequest): string {
  return createHash('sha256').update(JSON.stringify({ operationId: request.operationId, workspace: request.workspace, candidateWorkspace: request.candidateWorkspace,
    baseHash: request.baseHash, candidateHash: request.candidateHash, frozenCheck: request.frozenCheck, trustFingerprint: request.trustFingerprint })).digest('hex')
}

/** Main-owned source mutation. Unknown receipts are terminal: callers must not
 * replay because the process may have changed the workspace before its reply was lost. */
export class WorkflowSourceApplicationController {
  constructor(private readonly persistence: Persistence, private readonly dependencies: Dependencies, private readonly now = Date.now) {}

  async apply(request: WorkflowSourceApplicationRequest): Promise<WorkflowSourceApplicationReceipt> {
    const fingerprint = requestFingerprint(request)
    const prior = await this.persistence.load(request.operationId)
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw new Error('source application operationId 已用于其他请求')
      return prior
    }
    const requestedAt = this.now()
    const authority = await this.dependencies.authorize(request.workspace)
    if (authority.trustFingerprint !== request.trustFingerprint) return this.reject(request, requestedAt, fingerprint, 'workspace trust changed')
    const before = await this.dependencies.state(request.workspace)
    const candidate = await this.dependencies.state(request.candidateWorkspace)
    if (before.trustFingerprint !== request.trustFingerprint || candidate.trustFingerprint !== request.trustFingerprint) return this.reject(request, requestedAt, fingerprint, 'workspace trust changed')
    if (before.hash !== request.baseHash) return this.reject(request, requestedAt, fingerprint, 'source workspace drifted')
    if (candidate.hash !== request.candidateHash) return this.reject(request, requestedAt, fingerprint, 'candidate differs from frozen candidate')
    if (candidate.hash === request.baseHash) return this.reject(request, requestedAt, fingerprint, 'candidate has no changes')
    if (await this.dependencies.conflict?.(request.workspace, request.candidateWorkspace)) return this.reject(request, requestedAt, fingerprint, 'workspace conflict detected')
    const candidateCheck = await this.dependencies.check(request.candidateWorkspace, request.frozenCheck)
    if (candidateCheck !== 'passed') return this.reject(request, requestedAt, fingerprint, `candidate check ${candidateCheck}`)
    // Re-read the candidate immediately before mutation. The earlier check is
    // evidence for admission; it is not a lock on the candidate workspace.
    const candidateBeforeApply = await this.dependencies.state(request.candidateWorkspace)
    if (candidateBeforeApply.hash !== request.candidateHash || candidateBeforeApply.hash !== candidate.hash || candidateBeforeApply.trustFingerprint !== request.trustFingerprint) return this.reject(request, requestedAt, fingerprint, 'candidate changed before application')
    const intent: WorkflowSourceApplicationReceipt = { operationId: request.operationId, requestFingerprint: fingerprint, state: 'unknown', requestedAt, baseHash: request.baseHash, candidateHash: request.candidateHash, trustFingerprint: request.trustFingerprint, reason: 'application in progress' }
    await this.persistence.save(intent)
    try {
      const applied = await this.dependencies.apply(request.workspace, request.candidateWorkspace)
      const after = await this.dependencies.state(request.workspace)
      if (after.hash === request.baseHash) return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: 'application made no observed change' })
      if (after.hash !== intent.candidateHash) return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: 'applied source differs from the admitted candidate' })
      if (applied.state === 'partial') return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: 'candidate application was partial' })
      const finalCheck = await this.dependencies.check(request.workspace, request.frozenCheck)
      if (finalCheck !== 'passed') return this.finish({ ...intent, state: 'partial', changedPaths: applied.changedPaths, reason: `post-application check ${finalCheck}; rollback was not verified` })
      return this.finish({ ...intent, state: 'applied', changedPaths: applied.changedPaths })
    } catch (error) {
      return this.finish({ ...intent, state: 'unknown', reason: String(error) })
    }
  }

  private async reject(request: WorkflowSourceApplicationRequest, requestedAt: number, requestFingerprint: string, reason: string): Promise<WorkflowSourceApplicationReceipt> {
    return this.finish({ operationId: request.operationId, requestFingerprint, state: 'rejected', requestedAt, baseHash: request.baseHash, candidateHash: '', trustFingerprint: request.trustFingerprint, reason })
  }
  private async finish(receipt: WorkflowSourceApplicationReceipt): Promise<WorkflowSourceApplicationReceipt> {
    await this.persistence.save(receipt)
    return receipt
  }
}
