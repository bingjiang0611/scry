import type { ProviderId } from './provider.js'
import type { DangerLevel, DiffFile, TurnDiffReason, TurnDiffStatus } from './trace.js'

export type EvidenceQuality = 'exact' | 'estimated' | 'inferred' | 'unavailable'
export type EvidenceStatus = 'available' | 'partial' | 'disabled' | 'unavailable'

export interface Evidence<T> {
  status: EvidenceStatus
  quality: EvidenceQuality
  source: string[]
  value?: T
  omissionReason?: string
}

export type TurnCallStatus = 'started' | 'success' | 'failed' | 'cancelled' | 'unknown'

export interface TurnCall {
  id?: string
  parentId?: string
  name: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  status: TurnCallStatus
  input?: unknown
  outputSummary?: string
  error?: string
  file?: { operation: 'read' | 'write' | 'edit'; path: string }
  mcp?: { server?: string; action?: string; tool?: string }
}

export interface TurnHookCall {
  id?: string
  event: string
  name?: string
  command?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  status: TurnCallStatus
  exitCode?: number
}

export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  costUsd?: number
  model?: string
}

export interface TurnFile {
  path: string
  operation: 'read' | 'write' | 'edit'
}

export interface TurnDiffSnapshotRecord {
  status: TurnDiffStatus
  reason?: TurnDiffReason
  files: DiffFile[]
  repoRoot?: string
  scope?: string
  beforeAt: string
  afterAt: string
  captureMs: number
  cleanup: 'ok' | 'failed'
}

export interface TurnDanger {
  level: DangerLevel
  reason: string
  tool?: string
  toolUseId?: string
}

export interface TurnError {
  message: string
  source: string
  toolUseId?: string
}

export interface TurnEvidence {
  user: Evidence<{ text?: string; textHash?: string }>
  assistant: Evidence<{ text?: string; textHash?: string }>
  tools: Evidence<TurnCall[]>
  skills: Evidence<TurnCall[]>
  mcps: Evidence<TurnCall[]>
  hooks: Evidence<TurnHookCall[]>
  usage: Evidence<TurnUsage>
  files: Evidence<TurnFile[]>
  diff: Evidence<TurnDiffSnapshotRecord[]>
  dangerousOperations: Evidence<TurnDanger[]>
  errors: Evidence<TurnError[]>
}

export interface AgentTurnRecord extends TurnEvidence {
  schemaVersion: 1
  recordKind: 'agent_turn'
  sequence: number
  recordId: string
  recorderVersion: string
  workspace: { id: string; root: string }
  provider: { id: ProviderId; version?: string; model?: string }
  sessionId: string
  providerTurnId?: string
  generation: number
  turnIndex: number
  startedAt: string
  completedAt: string
  durationMs: number
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
}

export function available<T>(value: T, source: string[], quality: EvidenceQuality = 'exact'): Evidence<T> {
  return { status: 'available', quality, source, value }
}

export function unavailable<T>(reason: string, source: string[] = []): Evidence<T> {
  return { status: 'unavailable', quality: 'unavailable', source, omissionReason: reason }
}

export function disabled<T>(reason: string): Evidence<T> {
  return { status: 'disabled', quality: 'unavailable', source: ['config'], omissionReason: reason }
}

export function partial<T>(value: T, source: string[], reason: string, quality: EvidenceQuality = 'inferred'): Evidence<T> {
  return { status: 'partial', quality, source, value, omissionReason: reason }
}

function isEvidence(value: unknown): value is Evidence<unknown> {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return (
    ['available', 'partial', 'disabled', 'unavailable'].includes(String(raw.status)) &&
    ['exact', 'estimated', 'inferred', 'unavailable'].includes(String(raw.quality)) &&
    Array.isArray(raw.source)
  )
}

export function isAgentTurnRecord(value: unknown): value is AgentTurnRecord {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || raw.recordKind !== 'agent_turn') return false
  if (!Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1) return false
  if (typeof raw.recordId !== 'string' || !raw.recordId) return false
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return false
  if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1) return false
  if (!Number.isSafeInteger(raw.turnIndex) || Number(raw.turnIndex) < 1) return false
  if (typeof raw.startedAt !== 'string' || typeof raw.completedAt !== 'string') return false
  if (!raw.workspace || typeof raw.workspace !== 'object' || !raw.provider || typeof raw.provider !== 'object') return false
  const provider = raw.provider as Record<string, unknown>
  if (!['claude', 'codex', 'qoder', 'opencode'].includes(String(provider.id))) return false
  return [
    'user',
    'assistant',
    'tools',
    'skills',
    'mcps',
    'hooks',
    'usage',
    'files',
    'diff',
    'dangerousOperations',
    'errors'
  ].every((key) => isEvidence(raw[key]))
}
