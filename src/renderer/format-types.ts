// 渲染层共享的会话视图类型：一轮会话（Turn）与 MCP 状态。无 React 依赖，只描述 renderer 看到的形状。
import type { AgentInputAttachment } from '@shared/runtime'
import type { ProviderId } from '@shared/provider'
import type { TraceEvent } from '@shared/trace'

export interface Turn {
  runId: string
  /** Conversation ordinal of this turn; absent for a live placeholder that main has not recorded yet. */
  ordinal?: number
  /** Live run identity retained for Steer admission; history turns may omit it. */
  providerId?: ProviderId
  agentProfileId?: string
  cwd?: string
  externalSessionId?: string
  sessionId?: string
  /** Renderer-only placeholder shown while main is admitting a newly submitted run. */
  pendingStart?: boolean
  providerTurnId?: string
  forkTurnId?: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done: boolean
  error?: string
  errorHint?: string
}

export interface McpStatus {
  testing?: boolean
  ok?: boolean
  tools?: number
  toolNames?: string[]
  error?: string
  authenticating?: boolean
  authOk?: boolean
  authError?: string
}
