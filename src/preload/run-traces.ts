import { ipcRenderer } from 'electron'
import type { RunTraceEvent, RunTraceReceipt, RunTraceResyncResult, RunTraceSubscribeRequest, RunTraceSubscribeResult } from '../shared/run-traces'
import { RUN_TRACE_CHANNEL } from '../shared/run-traces'

/**
 * 单 run 的 live 流 preload 接口。
 *
 * 订阅 id 由 renderer 生成并随请求上送，这样 `subscribe` 的回执和事件谁先到都不影响归属：
 * 事件只交给注册了同一个 id 的那一个视图。没有 `runTraces` 的旧 preload 不能回退到
 * 轮询所有 run——main/preload/renderer 是一起发布的。
 */
export const runTracesApi = {
  setLegacyDiffPreviewDemand: (runId: string, demanded: boolean): Promise<boolean> =>
    ipcRenderer.invoke('runTraces:setLegacyDemand', runId, demanded),
  runTraces: {
    subscribe: (request: RunTraceSubscribeRequest): Promise<RunTraceSubscribeResult> =>
      ipcRenderer.invoke('runTraces:subscribe', request),
    unsubscribe: (subscriptionId: string): Promise<boolean> =>
      ipcRenderer.invoke('runTraces:unsubscribe', subscriptionId),
    ack: (subscriptionId: string, receipt: RunTraceReceipt): Promise<boolean> =>
      ipcRenderer.invoke('runTraces:ack', { subscriptionId, receipt }),
    resync: (subscriptionId: string): Promise<RunTraceResyncResult> =>
      ipcRenderer.invoke('runTraces:resync', subscriptionId),
    /** 拥有者在提交该快照之后才发：main 用它决定是否清除降级。 */
    confirmResync: (subscriptionId: string, resyncId: number): Promise<boolean> =>
      ipcRenderer.invoke('runTraces:confirm', { subscriptionId, resyncId }),
    onEvent: (cb: (event: RunTraceEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: RunTraceEvent): void => cb(payload)
      ipcRenderer.on(RUN_TRACE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(RUN_TRACE_CHANNEL, listener)
    }
  }
}
