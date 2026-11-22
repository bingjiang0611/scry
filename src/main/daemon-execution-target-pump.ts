import type { DesktopMobileTargetSubmit, DesktopRemoteTargetAPI } from '../shared/desktop-remote'
import { DaemonRunError } from './daemon-run-transport'
import { executionTargetError } from './remote/execution-target-error'
import { DEFAULT_MAX_FRAME } from './remote/inner-mtls-protocol'

export type ExecutionTargetWorkCall =
  | { callId: string; method: 'executionTargets'; input: Record<string, never> }
  | { callId: string; method: 'mobileRequest'; input: { target: { id: string; binding: string }; request: Record<string, unknown> } }
  | { callId: string; method: 'mobileSubmit'; input: DesktopMobileTargetSubmit }
  | { callId: string; method: 'mobileIntentStatus'; input: { target: { id: string; binding: string }; phonePeerFingerprint: string; phoneIntentId: string } }
  | { callId: string; method: 'shellOpenPath'; input: { path: string } }
  | { callId: string; method: 'shellTrashItem'; input: { path: string } }

export interface AppShellOps {
  openPath(path: string): Promise<void>
  trashItem(path: string): Promise<void>
}

export interface ExecutionTargetWorkSource {
  executionTargetWork(input: { waitMs: number }, signal?: AbortSignal): Promise<{ calls: ExecutionTargetWorkCall[] }>
  executionTargetResult(input: { callId: string; ok: boolean; result?: unknown; error?: string }, signal?: AbortSignal): Promise<{ accepted: boolean }>
}

export interface DaemonExecutionTargetPumpDeps {
  source: ExecutionTargetWorkSource
  client?: () => DesktopRemoteTargetAPI
  shellOps?: AppShellOps
  waitMs?: number
  retry?: { initialMs: number; maxMs: number }
  sleep?: (ms: number) => Promise<void>
  onWarn?: (message: string, detail?: unknown) => void
}

const DEFAULT_WAIT_MS = 20_000
const DEFAULT_RETRY = { initialMs: 1_000, maxMs: 30_000 }
// Reserve headroom for the surrounding JSON envelope (`protocol`, `keepAlive`, `op`, `callId`).
const MAX_RESULT_PAYLOAD_BYTES = DEFAULT_MAX_FRAME - 512

/**
 * App-side pull loop for daemon execution-target forwarding. Mirrors DaemonEventPump:
 * one long poll on its own lane receives queued phone-originated calls, executes each
 * concurrently against DesktopRemoteClient (which owns safeStorage credentials), and
 * posts bounded results back on the control lane.
 */
export class DaemonExecutionTargetPump {
  readonly #deps: DaemonExecutionTargetPumpDeps
  readonly #abort = new AbortController()
  #running = false

  constructor(deps: DaemonExecutionTargetPumpDeps) {
    this.#deps = deps
  }

  start(): void {
    if (this.#running || this.#abort.signal.aborted) return
    this.#running = true
    void this.#loop()
  }

  dispose(): void {
    this.#abort.abort()
  }

  async #loop(): Promise<void> {
    const { source } = this.#deps
    const retry = this.#deps.retry ?? DEFAULT_RETRY
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    let pause = retry.initialMs
    try {
      while (!this.#abort.signal.aborted) {
        let reply: { calls: ExecutionTargetWorkCall[] }
        try {
          reply = await source.executionTargetWork({ waitMs: this.#deps.waitMs ?? DEFAULT_WAIT_MS }, this.#abort.signal)
        } catch (error) {
          if (this.#abort.signal.aborted) return
          if (error instanceof DaemonRunError &&
            (error.reason === 'daemon_run_control_unavailable' || error.reason === 'daemon_device_not_authorized')) {
            this.#deps.onWarn?.('daemon execution target bridge unavailable', error)
            return
          }
          await sleep(pause)
          pause = Math.min(pause * 2, retry.maxMs)
          continue
        }
        if (this.#abort.signal.aborted) return
        pause = retry.initialMs
        for (const work of reply.calls) {
          void this.#runCall(work)
        }
      }
    } finally {
      this.#running = false
    }
  }

  async #runCall(work: ExecutionTargetWorkCall): Promise<void> {
    let payload: { callId: string; ok: boolean; result?: unknown; error?: string }
    try {
      let result: unknown
      if (work.method === 'shellOpenPath' || work.method === 'shellTrashItem') {
        const opName = work.method === 'shellOpenPath' ? 'openPath' : 'trashItem'
        const targetPath = work.input?.path
        if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.includes('\0')) {
          throw new Error('invalid_workbench_request')
        }
        const handler = this.#deps.shellOps?.[opName]
        if (!handler) throw new Error(`desktop_workbench_operation_unavailable:${opName}`)
        await handler(targetPath)
        result = null
      } else {
        const api = this.#deps.client?.()
        if (!api) throw new Error('execution_target_gateway_offline')
        if (work.method === 'executionTargets') {
          result = await api.executionTargets()
        } else if (work.method === 'mobileRequest') {
          result = await api.mobileRequest(work.input.target, work.input.request)
        } else if (work.method === 'mobileSubmit') {
          result = await api.mobileSubmit(work.input)
        } else if (work.method === 'mobileIntentStatus') {
          result = await api.mobileIntentStatus(work.input)
        } else {
          throw new Error('invalid_target_request')
        }
      }
      const bytes = Buffer.byteLength(JSON.stringify(result ?? null))
      payload = bytes > MAX_RESULT_PAYLOAD_BYTES
        ? { callId: work.callId, ok: false, error: 'execution_target_response_too_large' }
        : { callId: work.callId, ok: true, result }
    } catch (error) {
      const msg = error instanceof Error ? error.message : ''
      const code = msg.startsWith('desktop_workbench_operation_unavailable:') || msg === 'invalid_workbench_request'
        ? msg
        : executionTargetError(error).error
      payload = { callId: work.callId, ok: false, error: code }
    }
    if (this.#abort.signal.aborted) return
    try {
      await this.#deps.source.executionTargetResult(payload, this.#abort.signal)
    } catch (error) {
      if (!this.#abort.signal.aborted) this.#deps.onWarn?.('daemon execution target result failed', error)
    }
  }
}
