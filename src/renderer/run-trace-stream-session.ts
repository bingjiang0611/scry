import type { ActiveRun } from '@shared/trace'
import type {
  RunTraceEvent,
  RunTraceResyncResult,
  RunTraceSubscribeRequest,
  RunTraceSubscribeResult
} from '@shared/run-traces'
import type { TraceBatchReceipt } from './env'
import { TRACE_LIVE_HEALTHY, traceLiveHealthOf, type TraceLiveHealth } from './hooks/useAgentSession-helpers'
import {
  applyStreamBatch,
  applyStreamQuestion,
  applyStreamQuestionClosed,
  applyStreamStopState,
  mergeStreamSnapshot,
  mergeStreamTerminal,
  type RunTraceStreamState
} from './run-trace-stream'

export interface RunTraceStreamPort {
  subscribe: (request: RunTraceSubscribeRequest) => Promise<RunTraceSubscribeResult>
  unsubscribe: (subscriptionId: string) => Promise<boolean>
  ack: (subscriptionId: string, receipt: TraceBatchReceipt) => Promise<boolean>
  resync: (subscriptionId: string) => Promise<RunTraceResyncResult>
  confirmResync: (subscriptionId: string, resyncId: number) => Promise<boolean>
  onEvent: (cb: (event: RunTraceEvent) => void) => () => void
}

export type RunTraceStreamCommit =
  | { kind: 'batch'; subscriptionId: string; receipt: TraceBatchReceipt }
  | { kind: 'resync'; subscriptionId: string; resyncId: number }

export interface RunTraceStreamSessionOptions {
  runId: string
  port: RunTraceStreamPort
  subscriptionId?: string
  publish: (state: RunTraceStreamState & { health: TraceLiveHealth }) => void
  requestFlush: () => void
  flushNow: () => void
  onTerminal: (run: ActiveRun | null) => void
  createSubscriptionId?: () => string
}

export class RunTraceStreamSession {
  readonly subscriptionId: string
  private state: RunTraceStreamState & { health: TraceLiveHealth } = { status: 'connecting', health: TRACE_LIVE_HEALTHY }
  private queue: RunTraceEvent[] = []
  private commits: RunTraceStreamCommit[] = []
  private fenceGeneration = 0
  private hydrated = false
  private stopped = false
  private settled = false
  private resyncInFlight = false
  private resyncToken = 0
  private off?: () => void

  constructor(private readonly options: RunTraceStreamSessionOptions) {
    this.subscriptionId = options.subscriptionId ?? (options.createSubscriptionId ?? defaultSubscriptionId)()
  }

  start(): void {
    this.off = this.options.port.onEvent((event) => this.handle(event))
    void this.options.port
      .subscribe({ runId: this.options.runId, subscriptionId: this.subscriptionId })
      .then((result) => this.onSubscribed(result))
      .catch(() => this.update({ status: 'unavailable' }))
  }

  drain(): RunTraceStreamCommit[] {
    if (!this.hydrated || this.stopped) return []
    const queued = this.queue
    this.queue = []
    if (queued.length > 0) this.applyAll(queued)
    const commits = this.commits
    this.commits = []
    return commits
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.resyncToken += 1
    this.off?.()
    this.off = undefined
    this.queue = []
    this.commits = []
    void this.options.port.unsubscribe(this.subscriptionId).catch(() => undefined)
  }

  private onSubscribed(result: RunTraceSubscribeResult): void {
    if (this.stopped) {
      if (result.status === 'subscribed') void this.options.port.unsubscribe(this.subscriptionId).catch(() => undefined)
      return
    }
    if (result.status !== 'subscribed') {
      this.queue = []
      this.commits = []
      this.update({ status: result.status === 'limit' ? 'limit' : 'unavailable' })
      this.options.onTerminal(null)
      return
    }
    this.fenceGeneration = result.health.generation
    this.hydrated = true
    this.seed(result.run, { replace: false })
    this.update({ status: this.settled ? 'idle' : 'live', health: traceLiveHealthOf(result.health) })
    if (this.queue.length > 0) this.options.requestFlush()
    if (result.health.resyncRequired && !this.settled) this.requestResync()
  }

  private handle(event: RunTraceEvent): void {
    if (this.stopped || event.subscriptionId !== this.subscriptionId) return
    if (event.kind === 'health') {
      this.update({ health: traceLiveHealthOf(event.health) })
      if (event.health.resyncRequired && this.hydrated && !this.resyncInFlight) this.requestResync()
      return
    }
    this.queue.push(event)
    if (event.kind === 'trace') {
      this.commits.push({
        kind: 'batch',
        subscriptionId: this.subscriptionId,
        receipt: {
          generation: event.batch.generation,
          batchId: event.batch.batchId,
          bytes: event.batch.bytes
        }
      })
    }
    if (!this.hydrated) return
    if (event.kind === 'terminal') this.options.flushNow()
    else this.options.requestFlush()
  }

  private applyAll(events: RunTraceEvent[]): void {
    let run = this.state.run
    let terminal: Extract<RunTraceEvent, { kind: 'terminal' }> | undefined
    for (const event of events) {
      if (event.generation < this.fenceGeneration) continue
      switch (event.kind) {
        case 'trace':
          run = applyStreamBatch(run, event.batch.events) ?? run
          break
        case 'question':
          run = applyStreamQuestion(run, event.request) ?? run
          break
        case 'questionClosed':
          run = applyStreamQuestionClosed(run, event.runId, event.questionId) ?? run
          break
        case 'stopState':
          run = applyStreamStopState(run, event.state) ?? run
          break
        case 'terminal':
          if (this.settled) break
          if (event.run) run = mergeStreamTerminal(run, event.run)
          terminal = event
          break
      }
    }
    const patch: Partial<RunTraceStreamState & { health: TraceLiveHealth }> = {}
    if (run !== this.state.run) patch.run = run
    if (terminal) {
      this.settled = true
      patch.status = 'idle'
      patch.health = traceLiveHealthOf(terminal.health)
    }
    if (Object.keys(patch).length > 0) this.update(patch)
    if (terminal) this.options.onTerminal(terminal.run)
  }

  private seed(snapshot: ActiveRun, options: { replace: boolean }): boolean {
    if (this.settled && snapshot.done !== true) return false
    const base = options.replace ? snapshot : mergeStreamSnapshot(this.state.run, snapshot)
    if (base.done === true && !this.settled) {
      this.settled = true
      this.update({ run: base, status: 'idle' })
      this.options.onTerminal(base)
      return true
    }
    this.update({ run: base })
    return true
  }

  private requestResync(): void {
    const token = ++this.resyncToken
    this.resyncInFlight = true
    void this.options.port
      .resync(this.subscriptionId)
      .then((result) => {
        if (this.stopped || token !== this.resyncToken) return
        this.resyncInFlight = false
        if (result.status !== 'ok') return
        this.applyResync(result)
      })
      .catch(() => {
        if (token === this.resyncToken) this.resyncInFlight = false
      })
  }

  private applyResync(result: Extract<RunTraceResyncResult, { status: 'ok' }>): void {
    const generation = result.health.generation
    if (generation < this.fenceGeneration) return
    this.fenceGeneration = generation
    this.queue = this.queue.filter((event) => event.generation >= generation)
    this.commits = this.commits.filter((commit) => commit.kind !== 'batch' || commit.receipt.generation >= generation)
    this.hydrated = true
    if (!this.seed(result.run, { replace: true })) {
      return
    }
    this.update({ health: traceLiveHealthOf(result.health) })
    this.commits.push({ kind: 'resync', subscriptionId: this.subscriptionId, resyncId: result.resyncId })
    this.options.requestFlush()
  }

  private update(patch: Partial<RunTraceStreamState & { health: TraceLiveHealth }>): void {
    if (this.stopped) return
    this.state = { ...this.state, ...patch }
    this.options.publish(this.state)
  }
}

function defaultSubscriptionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `sub-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}
