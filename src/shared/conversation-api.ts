import type { ConversationBinding, ConversationContinuation, ConversationDelivery, ConversationItemRef, ConversationTarget } from './conversation'
import type { LoadedSessionTurn } from './session-history'
import type { AgentStartRequest } from './runtime'
import type { ProviderId } from './provider'

export interface ConversationSummary {
  id: string
  cwd: string
  title: string
  revision: number
  turnCount: number
  pinnedAt?: number
  archivedAt?: number
  activeRunId?: string
  blockedReason?: string
}

export interface ConversationPage {
  summary: ConversationSummary
  bindings: ConversationBinding[]
  turns: Array<{
    ordinal: number
    runId: string
    bindingId: string
    providerId: ProviderId
    delivery: ConversationDelivery | { status: 'imported' }
    history?: LoadedSessionTurn
    unavailableReason?: string
  }>
  nextBeforeOrdinal?: number
}

export interface ConversationPreview {
  conversationId: string
  revision: number
  target: ConversationTarget
  continuation: ConversationContinuation
  missingItems: Array<{
    ref: ConversationItemRef
    ordinal: number
    providerId: ProviderId
    role: 'user' | 'assistant'
  }>
}

export type ConversationTargetRequest = Pick<AgentStartRequest, 'model' | 'effort' | 'permissionMode'> & {
  providerId: ProviderId
  agentProfileId?: string
}

export interface ConversationSendRequest extends ConversationTargetRequest {
  conversationId: string
  expectedRevision: number
  expectedContinuationKey: string
  commandId: string
  prompt: string
  selectedItems: ConversationItemRef[]
  confirmFresh: boolean
}

export type ConversationMetadataChange =
  | { kind: 'rename'; title: string }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'archive'; archived: boolean }

export interface ConversationLegacySource {
  providerId: 'claude' | 'codex'
  cwd: string
  externalSessionId: string
}

export interface ConversationAdoptionPreview {
  source: ConversationLegacySource
  fingerprint: string
  title: string
  turnCount: number
}

/** Only these typed operations cross the preload boundary; runtime callbacks stay in main. */
export interface ConversationApi {
  create(cwd: string): Promise<ConversationSummary>
  previewAdoption(source: ConversationLegacySource): Promise<ConversationAdoptionPreview>
  adopt(source: ConversationLegacySource, fingerprint: string): Promise<ConversationSummary>
  update(id: string, expectedRevision: number, change: ConversationMetadataChange): Promise<ConversationSummary>
  list(cwd: string): Promise<ConversationSummary[]>
  read(id: string, beforeOrdinal?: number): Promise<ConversationPage>
  readItem(id: string, ref: ConversationItemRef): Promise<string>
  preview(id: string, target: ConversationTargetRequest): Promise<ConversationPreview>
  send(request: ConversationSendRequest): Promise<{ runId: string; disposition: 'created' | 'duplicate' }>
}
