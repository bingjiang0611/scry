import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { AgentQuestionRequest, AgentStopState } from '../shared/runtime'
import {
  isValidRunTraceRunId,
  isValidRunTraceSubscriptionId,
  type RunTraceEvent,
  type RunTraceReceipt,
  type RunTraceResyncResult,
  type RunTraceStreamHealth,
  type RunTraceSubscribeResult
} from '../shared/run-traces'
import { TraceOutputBridge, type TraceBacklogState } from './trace-output'

export const MAX_SCOPED_RUN_STREAMS = 2

const SCOPED_STREAM_LIMITS = {
  maxBatchEvents: 256,
  maxBatchBytes: 512 * 1024,
  highWaterBytes: 2 * 1024 * 1024,
  maxBufferBytes: 4 * 1024 * 1024,
  maxBufferEvents: 4_000
} as const

interface Subscription {
  id: string
  runId: string
  bridge: TraceOutputBridge
  resyncSeq: number
  pendingResync?: { id: number; generation: number }
  settledSnapshot?: ActiveRun
  settled: boolean
  closed: boolean
}

export interface RunTraceRouterDeps {
  runs: { get: (runId: string) => { state: ActiveRun } | undefined }
  boundedLiveRun: (run: ActiveRun) => ActiveRun
  canSend: () => boolean
  send: (event: RunTraceEvent) => void
  onDemandChange?: (runId: string, demanded: boolean) => void
  warn?: (message: string, detail: unknown) => void
  schedule?: (run: () => void, delayMs: number) => () => void
}

export class RunTraceRouter {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly byRun = new Map<string, Subscription>()
  private legacyRunId: string | null = null

  private attached: RunTraceRouterDeps['runs'] | undefined

  constructor(private readonly deps: RunTraceRouterDeps) {}

  attachRuns(source: RunTraceRouterDeps['runs']): () => void {
    this.attached = source
    return () => { if (this.attached === source) this.attached = undefined }
  }

  private runOf(runId: string): { state: ActiveRun } | undefined {
    return this.deps.runs.get(runId) ?? this.attached?.get(runId)
  }

  subscribe(request: unknown): RunTraceSubscribeResult {
    if (!request || typeof request !== 'object') return { status: 'rejected' }
    const { runId, subscriptionId } = request as { runId?: unknown; subscriptionId?: unknown }
    if (!isValidRunTraceRunId(runId) || !isValidRunTraceSubscriptionId(subscriptionId)) return { status: 'rejected' }
    const existing = this.byRun.get(runId)
    if (existing) {
      if (existing.id !== subscriptionId) return { status: 'rejected' }
      const run = this.snapshotOf(existing)
      return run
        ? { status: 'subscribed', subscriptionId: existing.id, run, health: this.healthOf(existing) }
        : { status: 'unavailable' }
    }
    const owner = this.subscriptions.get(subscriptionId)
    if (owner) return { status: 'rejected' }
    const state = this.runOf(runId)?.state
    if (!state) return { status: 'unavailable' }
    if (this.subscriptions.size >= MAX_SCOPED_RUN_STREAMS) return { status: 'limit' }
    const subscription: Subscription = {
      id: subscriptionId, runId, settled: false, closed: false, resyncSeq: 0,
      bridge: new TraceOutputBridge({
        canSend: this.deps.canSend,
        ...SCOPED_STREAM_LIMITS,
        flushMs: 16,
        ...(this.deps.schedule ? { schedule: this.deps.schedule } : {}),
        send: (payload) => this.emit(subscription, {
          kind: 'trace',
          subscriptionId: subscription.id,
          generation: payload.generation,
          batch: { events: payload.events, bytes: payload.bytes, generation: payload.generation, batchId: payload.batchId }
        }),
        publishHealth: (health) => this.emit(subscription, {
          kind: 'health', subscriptionId: subscription.id, generation: health.generation, health
        }),
        warn: (message, health) => this.deps.warn?.(message, { runId, health })
      })
    }
    this.subscriptions.set(subscription.id, subscription)
    this.byRun.set(runId, subscription)
    if (this.legacyRunId !== runId) this.deps.onDemandChange?.(runId, true)
    return {
      status: 'subscribed',
      subscriptionId: subscription.id,
      run: this.deps.boundedLiveRun(state),
      health: this.healthOf(subscription)
    }
  }

  unsubscribe(subscriptionId: unknown): boolean {
    if (typeof subscriptionId !== 'string') return false
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return false
    this.forget(subscription)
    return true
  }

  ack(subscriptionId: unknown, receipt: RunTraceReceipt | undefined): boolean {
    if (typeof subscriptionId !== 'string' || !receipt) return false
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || subscription.closed) return false
    return subscription.bridge.ack({
      generation: receipt.generation,
      batchId: receipt.batchId,
      bytes: receipt.bytes
    })
  }

  resync(subscriptionId: unknown): RunTraceResyncResult {
    if (typeof subscriptionId !== 'string') return { status: 'missing' }
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return { status: 'missing' }
    const run = this.snapshotOf(subscription)
    if (!run) return { status: 'missing' }
    const resyncId = ++subscription.resyncSeq
    const generation = subscription.bridge.fenceForSnapshot()
    subscription.pendingResync = { id: resyncId, generation }
    return { status: 'ok', run, resyncId, health: this.healthOf(subscription) }
  }

  confirmResync(subscriptionId: unknown, resyncId: unknown): boolean {
    if (typeof subscriptionId !== 'string' || !Number.isSafeInteger(resyncId)) return false
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || subscription.closed) return false
    const pending = subscription.pendingResync
    if (!pending || pending.id !== resyncId || pending.generation !== subscription.bridge.generation) return false
    subscription.pendingResync = undefined
    return subscription.bridge.confirmSnapshot(pending.generation)
  }

  route(event: TraceEvent): void {
    const subscription = this.byRun.get(event.runId)
    if (!subscription) return
    subscription.bridge.push(event)
  }

  publishQuestion(request: AgentQuestionRequest): void {
    const subscription = this.byRun.get(request.runId)
    if (!subscription) return
    this.emit(subscription, {
      kind: 'question', subscriptionId: subscription.id, generation: subscription.bridge.generation, request
    })
  }

  publishQuestionClosed(runId: string, questionId: string): void {
    const subscription = this.byRun.get(runId)
    if (!subscription) return
    this.emit(subscription, {
      kind: 'questionClosed', subscriptionId: subscription.id, generation: subscription.bridge.generation, runId, questionId
    })
  }

  publishStopState(state: AgentStopState): void {
    const subscription = this.byRun.get(state.runId)
    if (!subscription) return
    this.emit(subscription, {
      kind: 'stopState', subscriptionId: subscription.id, generation: subscription.bridge.generation, state
    })
  }

  settle(runId: string): void {
    const subscription = this.byRun.get(runId)
    if (!subscription || subscription.settled) return
    subscription.settled = true
    subscription.settledSnapshot = this.snapshotOf(subscription)
    subscription.bridge.flushAll()
    this.emit(subscription, {
      kind: 'terminal',
      subscriptionId: subscription.id,
      generation: subscription.bridge.generation,
      run: subscription.settledSnapshot ?? null,
      health: this.healthOf(subscription)
    })
  }

  reset(): void {
    for (const subscription of [...this.subscriptions.values()]) this.forget(subscription)
    if (this.legacyRunId) this.setLegacyDemand(this.legacyRunId, false)
  }

  rendererReady(): void {
    for (const subscription of this.subscriptions.values()) subscription.bridge.rendererReady()
  }

  close(): void {
    this.reset()
  }

  subscriptionCount(): number {
    return this.subscriptions.size
  }

  hasDemand(runId: string): boolean {
    return this.byRun.has(runId) || this.legacyRunId === runId
  }

  setLegacyDemand(runId: string, demanded: boolean): boolean {
    const previous = this.legacyRunId
    if (!demanded && previous !== runId) return false
    const next = demanded ? runId : null
    if (previous === next) return true
    this.legacyRunId = next
    if (previous && !this.byRun.has(previous)) this.deps.onDemandChange?.(previous, false)
    if (next && !this.byRun.has(next)) this.deps.onDemandChange?.(next, true)
    return true
  }

  private forget(subscription: Subscription): void {
    if (subscription.closed) return
    subscription.closed = true
    subscription.bridge.close()
    this.subscriptions.delete(subscription.id)
    if (this.byRun.get(subscription.runId) === subscription) {
      this.byRun.delete(subscription.runId)
      if (this.legacyRunId !== subscription.runId) this.deps.onDemandChange?.(subscription.runId, false)
    }
  }

  private snapshotOf(subscription: Subscription): ActiveRun | undefined {
    const state = this.runOf(subscription.runId)?.state
    if (state) return this.deps.boundedLiveRun(state)
    return subscription.settledSnapshot
  }

  private healthOf(subscription: Subscription): RunTraceStreamHealth {
    const state: TraceBacklogState = subscription.bridge.snapshot()
    return {
      generation: state.generation,
      degraded: state.degraded,
      skippedEvents: state.skippedEvents,
      bufferedEvents: state.bufferedEvents,
      bufferedBytes: state.bufferedBytes,
      inFlightBytes: state.inFlightBytes,
      resyncRequired: state.resyncRequired
    }
  }

  private emit(subscription: Subscription, event: RunTraceEvent): void {
    if (subscription.closed) return
    this.deps.send(event)
  }
}
