import { availableParallelism } from 'node:os'
import { workflowSlotLimit, type WorkflowAttemptOutcome, type WorkflowBlock } from '../shared/workflow'
import { WorkflowScopeError } from './workflow-runner-contracts'

interface WorkflowSlotResult {
  outcome: WorkflowAttemptOutcome
  hold?: Promise<void>
}

interface QueueItem {
  ownerId: string
  sequence: number
  block: Extract<WorkflowBlock, { kind: 'call' }>
  resolve: (outcome: WorkflowAttemptOutcome) => void
  reject: (error: unknown) => void
  resolveTask: () => Promise<WorkflowSlotResult>
}

/** Shared fair queue for planner and child Agent slots. */
export class WorkflowSlots {
  private readonly waiting = new Map<string, QueueItem[]>()
  private readonly genericWaiting = new Map<string, Array<{ sequence: number; run: () => Promise<void>; cancel: () => void }>>()
  private readonly ownerOrder: string[] = []
  private inUse = 0
  private reservedUnknown = 0
  private sequence = 0
  private ownerCursor = 0
  private currentLimit: number

  constructor(limit = workflowSlotLimit(availableParallelism())) {
    this.currentLimit = workflowSlotLimit(16, limit)
  }
  get limit(): number { return this.currentLimit }
  configure(limit: number): void { this.currentLimit = workflowSlotLimit(16, limit); this.pump() }
  cancelQueued(ownerId: string): void {
    const waiting = this.waiting.get(ownerId) ?? []
    this.waiting.delete(ownerId)
    // The owner flips its stop latch first. Cancelled Agent descriptors commit
    // cancellation without taking a slot or reserving a dispatch budget.
    for (const item of waiting) void this.run(item)
    const planning = this.genericWaiting.get(ownerId) ?? []
    this.genericWaiting.delete(ownerId)
    for (const item of planning) item.cancel()
    const index = this.ownerOrder.indexOf(ownerId)
    if (index >= 0) {
      this.ownerOrder.splice(index, 1)
      if (index < this.ownerCursor) this.ownerCursor--
    }
  }

  hasQueued(ownerId: string): boolean { return Boolean(this.waiting.get(ownerId)?.length || this.genericWaiting.get(ownerId)?.length) }
  get active(): number { return this.inUse + this.reservedUnknown }
  get reserved(): number { return this.reservedUnknown }
  reserveUnknown(): void { this.reservedUnknown += 1 }
  get queued(): number {
    let count = 0
    for (const queue of this.waiting.values()) count += queue.length
    for (const queue of this.genericWaiting.values()) count += queue.length
    return count
  }

  enqueue(item: Omit<QueueItem, 'sequence'>): Promise<WorkflowAttemptOutcome> {
    return new Promise((resolve, reject) => {
      const queued = { ...item, sequence: this.sequence++, resolve, reject }
      const queue = this.waiting.get(item.ownerId) ?? []
      queue.push(queued)
      this.waiting.set(item.ownerId, queue)
      this.registerOwner(item.ownerId)
      this.pump()
    })
  }

  withSlot<T>(task: () => Promise<T>, ownerId = '__planner__', scope?: () => Promise<void> | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.genericWaiting.get(ownerId) ?? []
      queue.push({ sequence: this.sequence++, cancel: () => reject(new Error('工作流规划已取消')), run: async () => {
        try { resolve(await task()) } catch (error) {
          reject(error)
          if (error instanceof WorkflowScopeError && !error.settled && !scope?.()) await new Promise<void>(() => {})
        } finally {
          // A result or a journal failure never frees a started native scope.
          // Rejected convergence remains reserved; its owner reports the error.
          const closed = scope?.()
          if (closed) await closed.catch(() => new Promise<void>(() => {}))
        }
      } })
      this.genericWaiting.set(ownerId, queue)
      this.registerOwner(ownerId)
      this.pump()
    })
  }

  private registerOwner(ownerId: string): void {
    if (!this.ownerOrder.includes(ownerId)) this.ownerOrder.push(ownerId)
  }

  private nextOwner(): string | undefined {
    for (let index = this.ownerOrder.length - 1; index >= 0; index--) {
      const ownerId = this.ownerOrder[index]
      if ((this.waiting.get(ownerId)?.length ?? 0) === 0 && (this.genericWaiting.get(ownerId)?.length ?? 0) === 0) this.ownerOrder.splice(index, 1)
    }
    if (this.ownerOrder.length === 0) { this.ownerCursor = 0; return undefined }
    this.ownerCursor %= this.ownerOrder.length
    for (let offset = 0; offset < this.ownerOrder.length; offset++) {
      const index = (this.ownerCursor + offset) % this.ownerOrder.length
      const ownerId = this.ownerOrder[index]
      if ((this.waiting.get(ownerId)?.length ?? 0) > 0 || (this.genericWaiting.get(ownerId)?.length ?? 0) > 0) {
        this.ownerCursor = (index + 1) % this.ownerOrder.length
        return ownerId
      }
    }
    return undefined
  }

  private pump(): void {
    while (this.inUse + this.reservedUnknown < this.limit) {
      const ownerId = this.nextOwner()
      if (!ownerId) return
      const agentQueue = this.waiting.get(ownerId)
      const genericQueue = this.genericWaiting.get(ownerId)
      const nextAgent = agentQueue?.[0]
      const nextGeneric = genericQueue?.[0]
      const useGeneric = nextGeneric !== undefined && (nextAgent === undefined || nextGeneric.sequence < nextAgent.sequence)
      const selectedAgent = useGeneric ? undefined : agentQueue?.shift()
      const selectedGeneric = useGeneric ? genericQueue?.shift() : undefined
      if (agentQueue?.length === 0) this.waiting.delete(ownerId)
      if (genericQueue?.length === 0) this.genericWaiting.delete(ownerId)
      this.inUse += 1
      const work = selectedGeneric ? selectedGeneric.run() : selectedAgent ? this.run(selectedAgent) : Promise.resolve()
      void work.finally(() => {
        this.inUse -= 1
        this.pump()
      }).catch(() => undefined)
    }
  }

  private async run(item: QueueItem): Promise<void> {
    try {
      const result = await Promise.resolve().then(() => item.resolveTask())
      item.resolve(result.outcome)
      if (result.hold) await result.hold
    } catch (error) {
      item.reject(error)
      // resolveTask handles known pre-dispatch refusals. An escaping error can
      // follow an external dispatch or a required outcome write failure: it is
      // not proof that this reservation is safe to release.
      await new Promise<void>(() => {})
    }
  }
}
