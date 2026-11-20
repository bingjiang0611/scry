import { randomUUID } from 'node:crypto'
import type { DesktopMobileTargetSubmit, DesktopRemoteTargetAPI, ExecutionTargetRef } from '../shared/desktop-remote'
import { DEFAULT_MAX_FRAME } from '../main/remote/inner-mtls-protocol'

// Timeout per forwarded target call: strictly greater than the 20 s max waitMs of
// watch/liveRuns (execution-targets.ts) so a legitimate long-poll never trips it.
export const EXECUTION_TARGET_CALL_TIMEOUT_MS = 35_000
export const EXECUTION_TARGET_POLL_MAX_WAIT_MS = 25_000
const DEFAULT_DETACH_GRACE_MS = 5_000
const MAX_QUEUED_CALLS = 64
const MAX_BATCH_CALLS = 16
const MAX_TARGETS = 32
const HASH = /^[a-f0-9]{64}$/

export type ExecutionTargetWorkCall =
  | { callId: string; method: 'executionTargets'; input: Record<string, never> }
  | { callId: string; method: 'mobileRequest'; input: { target: { id: string; binding: string }; request: Record<string, unknown> } }
  | { callId: string; method: 'mobileSubmit'; input: DesktopMobileTargetSubmit }
  | { callId: string; method: 'mobileIntentStatus'; input: { target: { id: string; binding: string }; phonePeerFingerprint: string; phoneIntentId: string } }

export interface ExecutionTargetResultInput {
  callId: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface ExecutionTargetBridgeHandlers {
  poll(peer: string, waitMs: number): Promise<{ calls: ExecutionTargetWorkCall[] }>
  submitResult(peer: string, input: ExecutionTargetResultInput): { accepted: boolean }
}

export interface AppExecutionTargetBridgeOptions {
  /** True only for the primary Scry App's enrolled local grant. */
  isPrimaryAppPeer(fingerprint: string): boolean
  /** Override per-call deadline in tests (default 35,000 ms). */
  callTimeoutMs?: number
  /** Override grace before marking App detached if polls stop while another socket stays open. */
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
    id: item.id, binding: item.binding, hostId: item.hostId, label: item.label, state: item.state
  }))
}

function sanitizeErrorCode(raw: unknown): string {
  if (typeof raw !== 'string') return 'execution_target_failed'
  const trimmed = raw.trim().slice(0, 128)
  return /^[a-zA-Z0-9_.:-]+$/.test(trimmed) ? trimmed : 'execution_target_failed'
}

/**
 * Daemon-side bridge that routes ExecutionTargetRouter calls to the primary Scry App
 * over local.sock using a long-poll pull (`executionTargetWork`) + reply (`executionTargetResult`)
 * pair. The daemon never holds the App's safeStorage desktop credentials; when the App is
 * absent, discovery honestly reports only the gateway (`targets: []`) and target calls fail
 * closed with `execution_target_gateway_offline`.
 */
export class AppExecutionTargetBridge {
  readonly #isPrimaryAppPeer: (fingerprint: string) => boolean
  readonly #callTimeoutMs: number
  readonly #detachGraceMs: number
  #connectedPeer: string | null = null
  #activePolls = 0
  #detachTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #queue: PendingCall[] = []
  #inFlight = new Map<string, PendingCall>()
  #waiters = new Set<() => void>()

  readonly client: DesktopRemoteTargetAPI
  readonly localHandlers: ExecutionTargetBridgeHandlers

  constructor(options: AppExecutionTargetBridgeOptions) {
    this.#isPrimaryAppPeer = options.isPrimaryAppPeer
    this.#callTimeoutMs = Math.max(10, options.callTimeoutMs ?? EXECUTION_TARGET_CALL_TIMEOUT_MS)
    this.#detachGraceMs = Math.max(10, options.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS)

    this.client = {
      executionTargets: async () => {
        if (!this.#hasLiveApp()) return []
        const result = await this.#enqueue({ callId: randomUUID(), method: 'executionTargets', input: {} })
        return validateTargetsResult(result)
      },
      mobileRequest: async (target, request, authorizePeer) => {
        authorizePeer?.()
        const result = await this.#enqueue(
          { callId: randomUUID(), method: 'mobileRequest', input: { target, request } },
          authorizePeer
        )
        authorizePeer?.()
        return result
      },
      mobileSubmit: async ({ authorizePeer, ...input }) => {
        authorizePeer?.()
        const result = await this.#enqueue(
          { callId: randomUUID(), method: 'mobileSubmit', input },
          authorizePeer
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

    this.localHandlers = {
      poll: (peer, waitMs) => this.#poll(peer, waitMs),
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

  #enqueue(call: ExecutionTargetWorkCall, authorizePeer?: () => void): Promise<unknown> {
    if (!this.#hasLiveApp()) return Promise.reject(new Error('execution_target_gateway_offline'))
    if (this.#queue.length + this.#inFlight.size >= MAX_QUEUED_CALLS) {
      return Promise.reject(new Error('execution_target_bridge_busy'))
    }
    const bytes = Buffer.byteLength(JSON.stringify(call))
    if (bytes > DEFAULT_MAX_FRAME) return Promise.reject(new Error('execution_target_frame_too_large'))
    return new Promise((resolve, reject) => {
      const pending: PendingCall = {
        call,
        bytes,
        authorizePeer,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#removePending(call.callId)
          reject(new Error('execution_target_timeout'))
        }, this.#callTimeoutMs)
      }
      pending.timer.unref?.()
      this.#queue.push(pending)
      this.#wakeWaiters()
    })
  }

  async #poll(peer: string, waitMs: number): Promise<{ calls: ExecutionTargetWorkCall[] }> {
    if (!this.#isPrimaryAppPeer(peer)) throw new Error('execution_target_bridge_unauthorized')
    if (this.#closed) return { calls: [] }
    if (this.#connectedPeer && this.#connectedPeer !== peer) {
      this.#detach('execution_target_gateway_offline')
    }
    this.#connectedPeer = peer
    this.#clearDetachTimer()
    this.#activePolls += 1
    try {
      let batch = this.#drainQueue(peer)
      if (batch.length === 0 && !this.#closed && waitMs > 0) {
        await this.#waitForWork(Math.min(waitMs, EXECUTION_TARGET_POLL_MAX_WAIT_MS))
        if (!this.#closed && this.#connectedPeer === peer) batch = this.#drainQueue(peer)
      }
      return { calls: batch }
    } finally {
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
    if (!input.ok) {
      pending.reject(new Error(sanitizeErrorCode(input.error)))
      return { accepted: true }
    }
    const resultBytes = Buffer.byteLength(JSON.stringify(input.result ?? null))
    if (resultBytes > DEFAULT_MAX_FRAME) {
      pending.reject(new Error('execution_target_response_too_large'))
      throw new Error('execution_target_response_too_large')
    }
    pending.resolve(input.result)
    return { accepted: true }
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
      if (item) clearTimeout(item.timer)
    }
    const inflight = this.#inFlight.get(callId)
    if (inflight) {
      this.#inFlight.delete(callId)
      clearTimeout(inflight.timer)
    }
  }

  #detach(errorCode: string): void {
    this.#clearDetachTimer()
    this.#connectedPeer = null
    this.#wakeWaiters()
    const queued = this.#queue.splice(0)
    const inflight = [...this.#inFlight.values()]
    this.#inFlight.clear()
    for (const item of [...queued, ...inflight]) {
      clearTimeout(item.timer)
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

  #waitForWork(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => { clearTimeout(timer); this.#waiters.delete(wake); resolve() }
      const timer = setTimeout(wake, timeoutMs)
      timer.unref?.()
      this.#waiters.add(wake)
    })
  }
}

export function createAppExecutionTargetBridge(options: AppExecutionTargetBridgeOptions): AppExecutionTargetBridge {
  return new AppExecutionTargetBridge(options)
}
