import type { DetectedAgent, ParsedTurn, ProjectMeta, ScryApi, SessionMeta, SessionRef } from '../preload'

export type { DetectedAgent, ParsedTurn, ProjectMeta, SessionMeta, SessionRef }
export type { McpMeta, SkillMeta } from '@shared/provider'

type OptionalBridgeMethod = 'rendererReady' | 'setTheme' | 'detectFast' | 'catalogHealth' | 'runControls' | 'onFocusedRun' | 'onDataUpdated'
type RendererScryApi = Omit<ScryApi, OptionalBridgeMethod> & Partial<Pick<ScryApi, OptionalBridgeMethod>>

declare global {
  interface Window {
    scry: RendererScryApi
  }
}

export {}
