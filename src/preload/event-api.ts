import { ipcRenderer } from 'electron'
import type { BackgroundWork } from '../shared/background-work'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import type { AgentDataUpdated, AgentQuestionRequest, AgentStopState } from '../shared/runtime'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { TraceBacklogState, TraceBatch, TraceBatchReceipt } from '../main/trace-output'
import type { TerminalDataEvent, TerminalRecordingErrorEvent, TerminalExitEvent } from '../shared/terminal'

export const eventApi = {
  onBackgroundWork: (cb: (event: { runId: string; work: BackgroundWork }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { runId: string; work: BackgroundWork }): void => cb(value)
    ipcRenderer.on('agent:backgroundWork', listener)
    return () => ipcRenderer.removeListener('agent:backgroundWork', listener)
  },
  onTrace: (cb: (events: TraceEvent[], receipt: TraceBatchReceipt) => void): (() => void) => {
    // The full batch crosses contextBridge once. Credit is returned by the renderer only after its
    // batched React update commits; merely invoking this callback is not proof of consumption.
    const l = (_: unknown, payload: TraceBatch): void => {
      const receipt = { generation: payload.generation, batchId: payload.batchId, bytes: payload.bytes }
      try {
        cb(payload.events, receipt)
      } catch (error) {
        // An exception means the batch was explicitly rejected rather than queued for a React
        // commit. Return only this fenced receipt so one bad consumer cannot deadlock all future
        // live delivery; canonical run/archive evidence remains authoritative.
        void ipcRenderer.invoke('agent:traceAck', receipt).catch(() => { })
        throw error
      }
    }
    ipcRenderer.on('agent:trace', l)
    return () => ipcRenderer.removeListener('agent:trace', l)
  },
  traceAck: (receipt: TraceBatchReceipt): Promise<boolean> => ipcRenderer.invoke('agent:traceAck', receipt),
  onTraceHealth: (cb: (state: TraceBacklogState) => void): (() => void) => {
    const l = (_: unknown, state: TraceBacklogState): void => cb(state)
    ipcRenderer.on('agent:traceHealth', l)
    return () => ipcRenderer.removeListener('agent:traceHealth', l)
  },
  traceResynchronized: (): Promise<true> => ipcRenderer.invoke('agent:traceResynchronized'),
  onTerminalData: (cb: (event: TerminalDataEvent) => void): (() => void) => {
    const listener = (_: unknown, events: TerminalDataEvent[]): void => {
      for (const event of events) cb(event)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalRecordingError: (cb: (event: TerminalRecordingErrorEvent) => void): (() => void) => {
    const listener = (_: unknown, event: TerminalRecordingErrorEvent): void => cb(event)
    ipcRenderer.on('terminal:recordingError', listener)
    return () => ipcRenderer.removeListener('terminal:recordingError', listener)
  },
  onTerminalExit: (cb: (event: TerminalExitEvent) => void): (() => void) => {
    const listener = (_: unknown, event: TerminalExitEvent): void => cb(event)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
  onTurnDone: (cb: (e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; stopped?: boolean }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; stopped?: boolean }): void => cb(e)
    ipcRenderer.on('agent:turnDone', l)
    return () => ipcRenderer.removeListener('agent:turnDone', l)
  },
  onUnreadSessions: (cb: (snapshot: SessionAttentionSnapshot) => void): (() => void) => {
    const listener = (_: unknown, snapshot: SessionAttentionSnapshot): void => cb(snapshot)
    ipcRenderer.on('agent:unreadSessions', listener)
    return () => ipcRenderer.removeListener('agent:unreadSessions', listener)
  },
  onStopState: (cb: (state: AgentStopState) => void): (() => void) => {
    const l = (_: unknown, state: AgentStopState): void => cb(state)
    ipcRenderer.on('agent:stopState', l)
    return () => ipcRenderer.removeListener('agent:stopState', l)
  },
  onDataUpdated: (cb: (e: AgentDataUpdated) => void): (() => void) => {
    const l = (_: unknown, e: AgentDataUpdated): void => cb(e)
    ipcRenderer.on('agent:dataUpdated', l)
    return () => ipcRenderer.removeListener('agent:dataUpdated', l)
  },
  onSession: (cb: (e: { runId: string; sessionId: string; previousSessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; pending?: boolean }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; sessionId: string; previousSessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; pending?: boolean }): void => cb(e)
    ipcRenderer.on('agent:session', l)
    return () => ipcRenderer.removeListener('agent:session', l)
  },
  onFocusedRun: (cb: (run: ActiveRun) => void): (() => void) => {
    const l = (_: unknown, run: ActiveRun): void => cb(run)
    ipcRenderer.on('agent:focusedRun', l)
    return () => ipcRenderer.removeListener('agent:focusedRun', l)
  },
  // A device-initiated (remote) run just wrote an AppSession into the catalog.
  // This is a refresh hint only (no active-run semantics), so the Mac session
  // list shows the phone's conversation live without corrupting local run state.
  onRemoteSessionRecorded: (cb: (e: { cwd: string }) => void): (() => void) => {
    const l = (_: unknown, e: { cwd: string }): void => cb(e)
    ipcRenderer.on('remote:sessionRecorded', l)
    return () => ipcRenderer.removeListener('remote:sessionRecorded', l)
  },
  onQuestion: (cb: (request: AgentQuestionRequest) => void): (() => void) => {
    const l = (_: unknown, request: AgentQuestionRequest): void => cb(request)
    ipcRenderer.on('agent:userQuestion', l)
    return () => ipcRenderer.removeListener('agent:userQuestion', l)
  },
  // Bounded attention summary: how many questions wait and how many of them are
  // permission decisions. No transcript content travels here.
  onQuestionAttention: (cb: (event: {
    runId: string; pendingCount: number; permissionCount?: number; inputCount?: number
  }) => void): (() => void) => {
    const l = (_: unknown, event: {
      runId: string; pendingCount: number; permissionCount?: number; inputCount?: number
    }): void => cb(event)
    ipcRenderer.on('agent:questionAttention', l)
    return () => ipcRenderer.removeListener('agent:questionAttention', l)
  },
  onQuestionClosed: (cb: (event: { runId: string; questionId: string }) => void): (() => void) => {
    const l = (_: unknown, event: { runId: string; questionId: string }): void => cb(event)
    ipcRenderer.on('agent:userQuestionClosed', l)
    return () => ipcRenderer.removeListener('agent:userQuestionClosed', l)
  },
  onError: (cb: (e: { runId: string; message: string; category?: string; hint?: string }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; message: string; category?: string; hint?: string }): void => cb(e)
    ipcRenderer.on('agent:error', l)
    return () => ipcRenderer.removeListener('agent:error', l)
  },
}
