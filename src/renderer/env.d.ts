import type {
  DetectedAgent,
  ParsedTurn,
  ProjectMeta,
  ScryApi,
  SessionHistoryPage,
  SessionHistoryPageRequest,
  SessionMeta,
  SessionRef,
  TraceBacklogState
} from '../preload'

export type {
  DetectedAgent,
  ParsedTurn,
  ProjectMeta,
  SessionHistoryPage,
  SessionHistoryPageRequest,
  SessionMeta,
  SessionRef,
  TraceBacklogState
}
export type { McpMeta, SkillMeta } from '@shared/provider'

type OptionalBridgeMethod =
  | 'rendererReady'
  | 'setTheme'
  | 'detectFast'
  | 'catalogHealth'
  | 'runControls'
  | 'onFocusedRun'
  | 'onRemoteSessionRecorded'
  | 'onDataUpdated'
  | 'onStopState'
  | 'loadSessionOlder'
  | 'onTraceHealth'
  | 'traceResynchronized'
  | 'focusedRunSnapshot'
type RendererScryApi = Omit<ScryApi, OptionalBridgeMethod> & Partial<Pick<ScryApi, OptionalBridgeMethod>>

declare global {
  interface Window {
    scry: RendererScryApi
  }
}

export {}
