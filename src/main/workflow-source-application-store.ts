import { opendir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from '../core/turn-recorder/io'
import type { WorkflowSourceApplicationReceipt, WorkflowSourceApplicationState } from '../shared/workflow-source-application'

const operationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const hashPattern = /^[a-f0-9]{64}$/
const states = new Set<WorkflowSourceApplicationState>(['applied', 'rejected', 'partial', 'unknown'])
const identityPattern = /^[A-Za-z0-9_-]{1,96}$/

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !operationPattern.test(value)) throw new Error('源码应用操作标识无效')
  return value
}
function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) throw new Error(`${name}无效`)
  return value
}
function parse(value: unknown): WorkflowSourceApplicationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('源码应用收据无效')
  const input = value as Record<string, unknown>
  const target = input.target, targetInput = target as Record<string, unknown>
  if (Object.keys(input).some(key => !['operationId', 'target', 'requestFingerprint', 'admissionFingerprint', 'state', 'requestedAt', 'baseHash', 'candidateHash', 'trustFingerprint', 'changedPaths', 'reason'].includes(key)) ||
    !target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['workflowId', 'programRevision', 'workflowRevision', 'stepId', 'nodeId'].includes(key)) ||
    typeof targetInput.workflowId !== 'string' || !identityPattern.test(targetInput.workflowId) || typeof targetInput.programRevision !== 'string' || !hashPattern.test(targetInput.programRevision) ||
    !Number.isSafeInteger(targetInput.workflowRevision) || Number(targetInput.workflowRevision) < 0 || typeof targetInput.stepId !== 'string' || !identityPattern.test(targetInput.stepId) ||
    typeof targetInput.nodeId !== 'string' || !identityPattern.test(targetInput.nodeId) ||
    !states.has(input.state as WorkflowSourceApplicationState) || !Number.isFinite(input.requestedAt) || Number(input.requestedAt) <= 0) throw new Error('源码应用收据无效')
  let changedPaths: string[] | undefined
  if (input.changedPaths !== undefined) {
    if (!Array.isArray(input.changedPaths) || input.changedPaths.length > 32768 || input.changedPaths.some(path => typeof path !== 'string' || !path || path.length > 4096 || path.startsWith('/') || path.split('/').includes('..'))) throw new Error('源码应用路径收据无效')
    changedPaths = [...input.changedPaths] as string[]
  }
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 4096)) throw new Error('源码应用原因无效')
  const acceptedTarget = targetInput
  return { operationId: operationId(input.operationId), target: { workflowId: String(acceptedTarget.workflowId), programRevision: String(acceptedTarget.programRevision), workflowRevision: Number(acceptedTarget.workflowRevision), stepId: String(acceptedTarget.stepId), nodeId: String(acceptedTarget.nodeId) },
    requestFingerprint: hash(input.requestFingerprint, '源码应用请求指纹'), admissionFingerprint: hash(input.admissionFingerprint, '源码应用准入指纹'),
    state: input.state as WorkflowSourceApplicationState, requestedAt: Number(input.requestedAt), baseHash: hash(input.baseHash, '源码基线哈希'),
    candidateHash: hash(input.candidateHash, '源码候选哈希'), trustFingerprint: hash(input.trustFingerprint, '源码信任指纹'),
    ...(changedPaths ? { changedPaths } : {}), ...(typeof input.reason === 'string' ? { reason: input.reason } : {}) }
}

export class WorkflowSourceApplicationStore {
  private readonly root: string
  constructor(userData: string) { this.root = join(userData, 'workflow-source-applications-v1') }

  private path(id: string): string { return join(this.root, `${operationId(id)}.json`) }

  async load(id: string): Promise<WorkflowSourceApplicationReceipt | undefined> {
    try {
      const text = await readFile(this.path(id), 'utf8')
      if (Buffer.byteLength(text) > 256 * 1024) throw new Error('源码应用收据过大')
      return parse(JSON.parse(text) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async save(receipt: WorkflowSourceApplicationReceipt): Promise<void> {
    const parsed = parse(receipt)
    await writeJsonAtomic(this.path(parsed.operationId), parsed)
  }

  async list(workflowId: string, programRevision: string): Promise<WorkflowSourceApplicationReceipt[]> {
    const receipts: WorkflowSourceApplicationReceipt[] = []
    let directory, scanned = 0
    try { directory = await opendir(this.root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return receipts
      throw error
    }
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      if (++scanned > 512) throw new Error('源码应用回执数量超过读取上限')
      const id = entry.name.slice(0, -5)
      if (!operationPattern.test(id)) continue
      const value = await this.load(id)
      if (value?.target.workflowId === workflowId && value.target.programRevision === programRevision) receipts.push(value)
    }
    return receipts.sort((left, right) => right.requestedAt - left.requestedAt || left.operationId.localeCompare(right.operationId))
  }
}
