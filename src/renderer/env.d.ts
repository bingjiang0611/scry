import type {
  DetectedAgent,
  ParsedTurn,
  ProjectMeta,
  ScryApi,
  SessionHistoryPage,
  SessionHistoryPageRequest,
  SessionMeta,
  SessionRef,
  TraceBacklogState,
  TraceBatchReceipt
} from '../preload'

export type {
  DetectedAgent,
  ParsedTurn,
  ProjectMeta,
  SessionHistoryPage,
  SessionHistoryPageRequest,
  SessionMeta,
  SessionRef,
  TraceBacklogState,
  TraceBatchReceipt
}
export type { McpMeta, SkillMeta } from '@shared/provider'

type OptionalBridgeMethod =
  | 'rendererReady'
  | 'setTheme'
  | 'performanceDiagnosticsEnabled'
  | 'reportRendererPerformance'
  | 'detectFast'
  | 'catalogHealth'
  | 'runControls'
  | 'onFocusedRun'
  | 'onQuestionAttention'
  | 'onRemoteSessionRecorded'
  | 'onDataUpdated'
  | 'onStopState'
  | 'loadSessionOlder'
  | 'onTraceHealth'
  | 'traceAck'
  | 'traceResynchronized'
  | 'focusedRunSnapshot'
  | 'unreadSessions'
  | 'onUnreadSessions'
type RendererScryApi = Omit<ScryApi, OptionalBridgeMethod> & Partial<Pick<ScryApi, OptionalBridgeMethod>>

declare global {
  interface Window {
    scry: RendererScryApi
  }
}

export {}
