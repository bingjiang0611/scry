import type { IpcMainInvokeEvent } from 'electron'
import type { RunTraceRouter } from '../run-trace-router'
import { isValidRunTraceRunId, type RunTraceReceipt } from '../../shared/run-traces'
import type { TrustedRegistrar } from './agent-runtime-ipc'

/**
 * run 级 live 流的特权入口。全部经生产 wrapper（handleTrusted）注册：
 * 先验 sender/frame/origin，再做 payload/归属校验，最后才碰 router。
 *
 * 这里不引入任意路径、命令或 run 创建能力：只能订阅/退订/确认/重对齐已经登记的 run，
 * 订阅本身不改变焦点、不停止运行，也不授予任何权限。
 */
export function registerRunTraceHandlers(
  handleTrusted: TrustedRegistrar, runTraces: RunTraceRouter, isFocusedRun: (runId: string) => boolean
): void {
  handleTrusted('runTraces:setLegacyDemand', (_event: IpcMainInvokeEvent, runId: unknown, demanded: unknown) => {
    if (!isValidRunTraceRunId(runId) || typeof demanded !== 'boolean') return false
    if (demanded && !isFocusedRun(runId)) return false
    return runTraces.setLegacyDemand(runId, demanded)
  })
  handleTrusted('runTraces:subscribe', (_event: IpcMainInvokeEvent, request: unknown) => runTraces.subscribe(request))
  handleTrusted('runTraces:unsubscribe', (_event: IpcMainInvokeEvent, subscriptionId: unknown) =>
    runTraces.unsubscribe(subscriptionId))
  handleTrusted('runTraces:ack', (_event: IpcMainInvokeEvent, payload: unknown) => {
    const { subscriptionId, receipt } = (payload ?? {}) as { subscriptionId?: unknown; receipt?: unknown }
    return runTraces.ack(subscriptionId, validReceipt(receipt))
  })
  handleTrusted('runTraces:resync', (_event: IpcMainInvokeEvent, subscriptionId: unknown) =>
    runTraces.resync(subscriptionId))
  // 重对齐的确认只能在拥有者提交快照之后发出，所以它和回执一样走严格校验。
  handleTrusted('runTraces:confirm', (_event: IpcMainInvokeEvent, payload: unknown) => {
    const { subscriptionId, resyncId } = (payload ?? {}) as { subscriptionId?: unknown; resyncId?: unknown }
    if (typeof subscriptionId !== 'string') throw new Error('run trace 确认无效')
    if (!Number.isSafeInteger(resyncId) || (resyncId as number) <= 0) throw new Error('run trace 确认无效')
    return runTraces.confirmResync(subscriptionId, resyncId)
  })
}

/**
 * 回执形状必须自证：非整数的代数/批次/字节直接拒绝，不交给 bridge 猜。
 * 与 legacy 通道一致地抛错——静默返回 false 会让「批量提交后没归还额度」变成难查的停更。
 */
function validReceipt(value: unknown): RunTraceReceipt {
  if (!value || typeof value !== 'object') throw new Error('run trace 回执无效')
  const { generation, batchId, bytes } = value as Record<string, unknown>
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) throw new Error('run trace 回执无效')
  if (!Number.isSafeInteger(batchId) || (batchId as number) < 0) throw new Error('run trace 回执无效')
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) throw new Error('run trace 回执无效')
  return { generation: generation as number, batchId: batchId as number, bytes: bytes as number }
}
