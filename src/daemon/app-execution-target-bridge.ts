import { randomUUID } from 'node:crypto'
import type { DesktopRemoteTargetAPI, ExecutionTargetRef } from '../shared/desktop-remote'
import { MAX_EXECUTION_TARGET_WORK_CALLS, type ExecutionTargetWorkCall, type ExecutionTargetWorkReply } from '../shared/execution-target-work'
import { DEFAULT_MAX_FRAME } from '../main/remote/inner-mtls-protocol'

export const EXECUTION_TARGET_CALL_TIMEOUT_MS = 45_000
export const EXECUTION_TARGET_SUBMIT_TIMEOUT_MS = 65_000
export const EXECUTION_TARGET_POLL_MAX_WAIT_MS = 25_000
export const MAX_EXECUTION_TARGET_RESULT_BYTES = DEFAULT_MAX_FRAME - 512
const DEFAULT_DETACH_GRACE_MS = 5_000
const MAX_BATCH_CALLS = 16
const MAX_TARGETS = 32
const HASH = /^[a-f0-9]{64}$/

export interface BridgedShellOps {
  isAvailable(): boolean
  openPath(path: string): Promise<void>
  trashItem(path: string): Promise<void>
}

export interface ExecutionTargetResultInput {
  callId: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface ExecutionTargetBridgeHandlers {
  poll(peer: string, waitMs: number, signal?: AbortSignal, ackCancelledCallIds?: string[]): Promise<ExecutionTargetWorkReply>
  submitResult(peer: string, input: ExecutionTargetResultInput): { accepted: boolean }
}

export interface AppExecutionTargetBridgeOptions {
  isPrimaryAppPeer(fingerprint: string): boolean
  callTimeoutMs?: number
  submitTimeoutMs?: number
  detachGraceMs?: number
}

interface PendingCall {
  call: ExecutionTargetWorkCall
  bytes: number
  ownerPeer?: string
  authorizePeer?: () => void
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbortListener: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isTargetRef(value: unknown): value is ExecutionTargetRef {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 300 &&
    typeof value.binding === 'string' && HASH.test(value.binding) &&
    typeof value.hostId === 'string' && value.hostId.length > 0 && value.hostId.length <= 128 &&
    typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 256 &&
    (value.state === 'connected' || value.state === 'disconnected')
}

function validateTargetsResult(value: unknown): ExecutionTargetRef[] {
  if (!Array.isArray(value)) throw new Error('invalid_target_response')
  if (value.length > MAX_TARGETS) throw new Error('execution_target_capacity_exceeded')
  if (!value.every(isTargetRef)) throw new Error('invalid_target_response')
  return value.map((item) => ({
    id: item.id, binding: item.binding, hostId: item.hostId, label: item.label, state: item.state,
    ...(item.subscribe === 1 ? { subscribe: 1 as const } : {})
  }))
}

function sanitizeErrorCode(raw: unknown): string {
  if (typeof raw !== 'string') return 'execution_target_failed'
  const trimmed = raw.trim().slice(0, 128)
  return /^[a-zA-Z0-9_.:-]+$/.test(trimmed) ? trimmed : 'execution_target_failed'
}

export class AppExecutionTargetBridge {
  readonly #isPrimaryAppPeer: (fingerprint: string) => boolean
  readonly #callTimeoutMs: number
  readonly #submitTimeoutMs: number
  readonly #detachGraceMs: number
  #connectedPeer: string | null = null
  #activePolls = 0
  #activePoll: { wake: () => void; cancelled: boolean } | null = null
  #detachTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #queue: PendingCall[] = []
  #inFlight = new Map<string, PendingCall>()
  #cancelledCallIds = new Set<string>()
  #waiters = new Set<() => void>()

  readonly client: DesktopRemoteTargetAPI
  readonly shellOps: BridgedShellOps
  readonly localHandlers: ExecutionTargetBridgeHandlers

  constructor(options: AppExecutionTargetBridgeOptions) {
    this.#isPrimaryAppPeer = options.isPrimaryAppPeer
    this.#callTimeoutMs = Math.max(10, options.callTimeoutMs ?? EXECUTION_TARGET_CALL_TIMEOUT_MS)
    this.#submitTimeoutMs = Math.max(
      this.#callTimeoutMs,
      options.submitTimeoutMs ?? (options.callTimeoutMs === undefined ? EXECUTION_TARGET_SUBMIT_TIMEOUT_MS : this.#callTimeoutMs)
    )
    this.#detachGraceMs = Math.max(10, options.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS)

    this.client = {
      executionTargets: async () => {
        if (!this.#hasLiveApp()) return []
        try {
          const result = await this.#enqueue({ callId: randomUUID(), method: 'executionTargets', input: {} })
          return validateTargetsResult(result)
        } catch (error) {
          const code = (error as Error)?.message
          if (code === 'execution_target_gateway_offline' || code === 'execution_target_timeout' || code === 'execution_target_bridge_busy') {
            return []
          }
          throw error
        }
      },
      mobileRequest: async (target, request, authorizePeer, signal) => {
        authorizePeer?.()
        const result = await this.#enqueue(
          { callId: randomUUID(), method: 'mobileRequest', input: { target, request } },
          authorizePeer,
          this.#callTimeoutMs,
          request.op === 'subscribe' ? signal : undefined
        )
        authorizePeer?.()
        return result
      },
      mobileSubmit: async ({ authorizePeer, ...input }) => {
        authorizePeer?.()
        const result = await this.#enqueue(
          { callId: randomUUID(), method: 'mobileSubmit', input },
          authorizePeer,
          this.#submitTimeoutMs
        )
        authorizePeer?.()
        return result
      },
      mobileIntentStatus: async ({ authorizePeer, ...input }) => {
        authorizePeer?.()
        const result = await this.#enqueue(
          { callId: randomUUID(), method: 'mobileIntentStatus', input },
          authorizePeer
        )
        authorizePeer?.()
        return result
      }
    }

    const invokeShell = async (method: 'shellOpenPath' | 'shellTrashItem', opName: 'openPath' | 'trashItem', path: string): Promise<void> => {
      if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new Error('invalid_workbench_request')
      if (!this.#hasLiveApp()) throw new Error(`desktop_workbench_operation_unavailable:${opName}`)
      try {
        await this.#enqueue({ callId: randomUUID(), method, input: { path } })
      } catch (error) {
        if ((error as Error)?.message === 'execution_target_gateway_offline') {
          throw new Error(`desktop_workbench_operation_unavailable:${opName}`)
        }
        throw error
      }
    }
    this.shellOps = {
      isAvailable: () => this.#hasLiveApp(),
      openPath: (path) => invokeShell('shellOpenPath', 'openPath', path),
      trashItem: (path) => invokeShell('shellTrashItem', 'trashItem', path)
    }

    this.localHandlers = {
      poll: (peer, waitMs, signal, ackCancelledCallIds) => this.#poll(peer, waitMs, signal, ackCancelledCallIds),
      submitResult: (peer, input) => this.#submitResult(peer, input)
    }
  }

  onPeerDisconnected(fingerprint: string): void {
    if (this.#connectedPeer !== fingerprint) return
    this.#detach('execution_target_gateway_offline')
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#detach('execution_target_gateway_offline')
  }

  #hasLiveApp(): boolean {
    if (this.#closed || !this.#connectedPeer) return false
    if (!this.#isPrimaryAppPeer(this.#connectedPeer)) {
      this.#detach('execution_target_gateway_offline')
      return false
    }
    return true
  }

  #enqueue(call: ExecutionTargetWorkCall, authorizePeer?: () => void, timeoutMs = this.#callTimeoutMs, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('execution_target_cancelled'))
    if (!this.#hasLiveApp()) return Promise.reject(new Error('execution_target_gateway_offline'))
    if (this.#queue.length + this.#inFlight.size + this.#cancelledCallIds.size >= MAX_EXECUTION_TARGET_WORK_CALLS) {
      return Promise.reject(new Error('execution_target_bridge_busy'))
    }
    const bytes = Buffer.byteLength(JSON.stringify(call))
    if (bytes > DEFAULT_MAX_FRAME) return Promise.reject(new Error('execution_target_frame_too_large'))
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        const assigned = this.#inFlight.has(call.callId)
        this.#removePending(call.callId)
        if (assigned) {
          this.#cancelledCallIds.add(call.callId)
          this.#wakeWaiters()
        }
        reject(new Error('execution_target_cancelled'))
      }
      const pending: PendingCall = {
        call,
        bytes,
        authorizePeer,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener('abort', cancel),
        timer: setTimeout(() => {
          this.#removePending(call.callId)
          reject(new Error('execution_target_timeout'))
        }, timeoutMs)
      }
      pending.timer.unref?.()
      this.#queue.push(pending)
      signal?.addEventListener('abort', cancel, { once: true })
      this.#wakeWaiters()
    })
  }

  async #poll(peer: string, waitMs: number, signal?: AbortSignal, ackCancelledCallIds: string[] = []): Promise<ExecutionTargetWorkReply> {
    if (!this.#isPrimaryAppPeer(peer)) throw new Error('execution_target_bridge_unauthorized')
    if (this.#closed || signal?.aborted) return { calls: [] }
    if (this.#connectedPeer && this.#connectedPeer !== peer) {
      this.#detach('execution_target_gateway_offline')
    }
    if (this.#activePoll) {
      this.#activePoll.cancelled = true
      this.#activePoll.wake()
      this.#activePoll = null
    }
    this.#connectedPeer = peer
    for (const id of ackCancelledCallIds) this.#cancelledCallIds.delete(id)
    this.#clearDetachTimer()
    this.#activePolls += 1
    const pollState = { wake: () => undefined as void, cancelled: false }
    this.#activePoll = pollState
    const onAbort = (): void => {
      pollState.cancelled = true
      pollState.wake()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let reply = this.#readWork(peer)
      if (reply.calls.length === 0 && !reply.cancelledCallIds && !this.#closed && !pollState.cancelled && !signal?.aborted && waitMs > 0) {
        await this.#waitForWork(Math.min(waitMs, EXECUTION_TARGET_POLL_MAX_WAIT_MS), pollState)
        if (!this.#closed && !pollState.cancelled && !signal?.aborted && this.#activePoll === pollState && this.#connectedPeer === peer) {
          reply = this.#readWork(peer)
        }
      }
      return reply
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (this.#activePoll === pollState) this.#activePoll = null
      this.#activePolls -= 1
      if (this.#activePolls === 0 && !this.#closed && this.#connectedPeer === peer) {
        this.#armDetachTimer(peer)
      }
    }
  }

  #submitResult(peer: string, input: ExecutionTargetResultInput): { accepted: boolean } {
    if (!this.#isPrimaryAppPeer(peer)) throw new Error('execution_target_bridge_unauthorized')
    const pending = this.#inFlight.get(input.callId)
    if (!pending || pending.ownerPeer !== peer) return { accepted: false }
    this.#inFlight.delete(input.callId)
    clearTimeout(pending.timer)
    pending.removeAbortListener()
    if (!input.ok) {
      pending.reject(new Error(sanitizeErrorCode(input.error)))
      return { accepted: true }
    }
    const resultBytes = Buffer.byteLength(JSON.stringify(input.result ?? null))
    if (resultBytes > MAX_EXECUTION_TARGET_RESULT_BYTES) {
      pending.reject(new Error('execution_target_response_too_large'))
      throw new Error('execution_target_response_too_large')
    }
    pending.resolve(input.result)
    return { accepted: true }
  }

  #readWork(peer: string): ExecutionTargetWorkReply {
    // Repeat cancellations until the App acknowledges them. Send a control-only
    // reply so a full work batch keeps its existing frame budget.
    if (this.#cancelledCallIds.size > 0) return { calls: [], cancelledCallIds: [...this.#cancelledCallIds] }
    return { calls: this.#drainQueue(peer) }
  }

  #drainQueue(peer: string): ExecutionTargetWorkCall[] {
    const batch: ExecutionTargetWorkCall[] = []
    let totalBytes = 64
    while (this.#queue.length > 0 && batch.length < MAX_BATCH_CALLS) {
      const next = this.#queue[0]!
      if (batch.length > 0 && totalBytes + next.bytes + 2 > DEFAULT_MAX_FRAME) break
      this.#queue.shift()
      next.ownerPeer = peer
      this.#inFlight.set(next.call.callId, next)
      batch.push(next.call)
      totalBytes += next.bytes + 2
    }
    return batch
  }

  #removePending(callId: string): void {
    const idx = this.#queue.findIndex((item) => item.call.callId === callId)
    if (idx >= 0) {
      const [item] = this.#queue.splice(idx, 1)
      if (item) {
        clearTimeout(item.timer)
        item.removeAbortListener()
      }
    }
    const inflight = this.#inFlight.get(callId)
    if (inflight) {
      this.#inFlight.delete(callId)
      clearTimeout(inflight.timer)
      inflight.removeAbortListener()
    }
  }

  #detach(errorCode: string): void {
    this.#clearDetachTimer()
    this.#connectedPeer = null
    this.#wakeWaiters()
    const queued = this.#queue.splice(0)
    const inflight = [...this.#inFlight.values()]
    this.#inFlight.clear()
    this.#cancelledCallIds.clear()
    for (const item of [...queued, ...inflight]) {
      clearTimeout(item.timer)
      item.removeAbortListener()
      item.reject(new Error(errorCode))
    }
  }

  #armDetachTimer(peer: string): void {
    this.#clearDetachTimer()
    this.#detachTimer = setTimeout(() => {
      if (this.#activePolls === 0 && this.#connectedPeer === peer) {
        this.#detach('execution_target_gateway_offline')
      }
    }, this.#detachGraceMs)
    this.#detachTimer.unref?.()
  }

  #clearDetachTimer(): void {
    if (this.#detachTimer) clearTimeout(this.#detachTimer)
    this.#detachTimer = undefined
  }

  #wakeWaiters(): void {
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    for (const wake of waiters) wake()
  }

  #waitForWork(timeoutMs: number, pollState: { wake: () => void; cancelled: boolean }): Promise<void> {
    if (pollState.cancelled) return Promise.resolve()
    return new Promise((resolve) => {
      const wake = (): void => { clearTimeout(timer); this.#waiters.delete(wake); resolve() }
      const timer = setTimeout(wake, timeoutMs)
      timer.unref?.()
      pollState.wake = wake
      this.#waiters.add(wake)
    })
  }
}

export function createAppExecutionTargetBridge(options: AppExecutionTargetBridgeOptions): AppExecutionTargetBridge {
  return new AppExecutionTargetBridge(options)
}
