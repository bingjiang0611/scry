import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from '../core/turn-recorder/io'

const identityPattern = /^[A-Za-z0-9_-]{1,128}$/
const taskPattern = /^[A-Za-z0-9_.:-]{1,512}$/
const statuses = new Set<WorkflowRunSettlement['status']>(['completed', 'failed', 'cancelled', 'interrupted', 'unknown', 'blocked'])

export type WorkflowRunSettlement = Readonly<{
  schemaVersion: 1
  workflowId: string
  taskId: string
  attemptId: string
  runId: string
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown' | 'blocked'
  settledAt: number
  source: 'app_run_terminal'
}>

function identity(value: unknown, name: string): string {
  if (typeof value !== 'string' || !identityPattern.test(value)) throw new Error(`${name}无效`)
  return value
}

function parse(value: unknown): WorkflowRunSettlement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作流运行收敛回执无效')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['schemaVersion', 'workflowId', 'taskId', 'attemptId', 'runId', 'status', 'settledAt', 'source'].includes(key)) ||
    input.schemaVersion !== 1 || !statuses.has(input.status as WorkflowRunSettlement['status']) ||
    !Number.isSafeInteger(input.settledAt) || Number(input.settledAt) <= 0 || input.source !== 'app_run_terminal') throw new Error('工作流运行收敛回执无效')
  const attemptId = identity(input.attemptId, '工作流 attempt 标识')
  const runId = identity(input.runId, '工作流 run 标识')
  if (runId !== `workflow-${attemptId}`) throw new Error('工作流运行收敛回执身份不匹配')
  if (typeof input.taskId !== 'string' || !taskPattern.test(input.taskId)) throw new Error('工作流任务标识无效')
  return { schemaVersion: 1, workflowId: identity(input.workflowId, '工作流标识'), taskId: input.taskId, attemptId, runId,
    status: input.status as WorkflowRunSettlement['status'], settledAt: Number(input.settledAt), source: 'app_run_terminal' }
}

export class WorkflowRunSettlementStore {
  private readonly root: string
  constructor(userData: string) { this.root = join(userData, 'workflow-run-settlements-v1') }

  private path(attemptId: string): string {
    const id = identity(attemptId, '工作流 attempt 标识')
    return join(this.root, `${createHash('sha256').update(id).digest('hex')}.json`)
  }

  async load(attemptId: string): Promise<WorkflowRunSettlement | undefined> {
    try {
      const text = await readFile(this.path(attemptId), 'utf8')
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('工作流运行收敛回执过大')
      const settlement = parse(JSON.parse(text) as unknown)
      if (settlement.attemptId !== attemptId) throw new Error('工作流运行收敛回执身份不匹配')
      return settlement
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async save(settlement: WorkflowRunSettlement): Promise<void> {
    const parsed = parse(settlement)
    await writeJsonAtomic(this.path(parsed.attemptId), parsed)
  }
}
