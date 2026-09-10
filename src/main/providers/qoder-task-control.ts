import { randomUUID } from 'node:crypto'
import type { Transport } from '@qoder-ai/qoder-agent-sdk'
import type { BackgroundTaskStopResult } from '../../shared/background-work'

const prefix = 'scry-task-stop:'

/** Public SDK transport extension, not Query's private request() or arbitrary stdin IPC.
 * The stop_task wire is verified for CLI 1.1.45 only. Unknown runtimes fail closed.
 */
export class QoderTaskControlTransport implements Transport {
  private version?: string
  private pending = new Map<string, { finish: (result: BackgroundTaskStopResult) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private inner: Transport) {}
  initialize(): Promise<void> { return this.inner.initialize() }
  isReady(): boolean { return this.inner.isReady() }
  write(data: string): void | Promise<void> { return this.inner.write(data) }
  endInput(): void { this.inner.endInput() }
  get canStopTask(): boolean { return this.version === '1.1.45' && this.isReady() }

  stopTask(taskId: string): Promise<BackgroundTaskStopResult> {
    if (!this.canStopTask) return Promise.resolve({ status: 'unavailable', message: '当前 Qoder 版本的单任务停止尚未验证，请使用停止本轮。' })
    const id = `${prefix}${randomUUID()}`
    return new Promise((finish) => {
      const timer = setTimeout(() => this.finish(id, {
        status: 'unknown', message: '停止请求未获确认；任务可能仍在执行，不会自动重复请求。'
      }), 10_000)
      this.pending.set(id, { finish, timer })
      try {
        Promise.resolve(this.inner.write(JSON.stringify({
          type: 'control_request', request_id: id, request: { subtype: 'stop_task', task_id: taskId }
        }))).catch(() => this.finish(id, { status: 'unknown', message: '停止请求传输中断，结果未知。' }))
      } catch {
        this.finish(id, { status: 'unknown', message: '停止请求传输中断，结果未知。' })
      }
    })
  }

  private finish(id: string, result: BackgroundTaskStopResult): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.finish(result)
  }

  async *readMessages(): ReturnType<Transport['readMessages']> {
    try {
      for await (const frame of this.inner.readMessages()) {
        const raw = frame as unknown as Record<string, unknown>
        if (raw.type === 'system' && raw.subtype === 'init' && !raw.parent_tool_use_id && raw.isReplay !== true && typeof raw.qodercli_version === 'string') this.version = raw.qodercli_version
        const response = raw.response as Record<string, unknown> | undefined
        if (raw.type === 'control_response' && typeof response?.request_id === 'string' && response.request_id.startsWith(prefix)) {
          this.finish(response.request_id, response.subtype === 'success'
            ? { status: 'requested', message: '已请求停止；等待 Qoder 返回任务终态。' }
            : { status: 'rejected', message: 'Qoder 拒绝了单任务停止请求；可使用停止本轮。' })
          continue
        }
        yield frame
      }
    } finally { this.cancelPending() }
  }

  private cancelPending(): void {
    for (const id of this.pending.keys()) this.finish(id, { status: 'unknown', message: 'Qoder 连接已结束，停止结果未确认。' })
  }
  close(): void { this.cancelPending(); this.inner.close() }
}
