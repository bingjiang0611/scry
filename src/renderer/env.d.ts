import type { DetectedAgent, ParsedTurn, ProjectMeta, ScryApi, SessionMeta } from '../preload'

export type { DetectedAgent, ParsedTurn, ProjectMeta, SessionMeta }
export type { McpMeta, SkillMeta } from '@shared/provider'

type OptionalBridgeMethod = 'rendererReady' | 'detectFast' | 'catalogHealth' | 'runControls'
type RendererScryApi = Omit<ScryApi, OptionalBridgeMethod> & Partial<Pick<ScryApi, OptionalBridgeMethod>>

declare global {
  interface Window {
    scry: RendererScryApi
  }
}

export {}
