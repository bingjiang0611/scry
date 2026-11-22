import { ipcRenderer } from 'electron'
import type { RunTraceEvent, RunTraceReceipt, RunTraceResyncResult, RunTraceSubscribeRequest, RunTraceSubscribeResult } from '../shared/run-traces'
import { RUN_TRACE_CHANNEL } from '../shared/run-traces'

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
    confirmResync: (subscriptionId: string, resyncId: number): Promise<boolean> =>
      ipcRenderer.invoke('runTraces:confirm', { subscriptionId, resyncId }),
    onEvent: (cb: (event: RunTraceEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: RunTraceEvent): void => cb(payload)
      ipcRenderer.on(RUN_TRACE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(RUN_TRACE_CHANNEL, listener)
    }
  }
}
