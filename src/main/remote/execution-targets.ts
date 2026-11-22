import { createHash } from 'node:crypto'
import type { DesktopMobileTargetSubmit, ExecutionTargetRef } from '../../shared/desktop-remote'
import { parseSubscribeFrame } from './subscribe-frame'
import { parseRemoteWorkspaceQuery } from './remote-workspace'
import { parseRemoteFileDownloadQuery } from './remote-file-download'
import { historyProfileSelection, historyScopeSelection } from './remote-gateway'
export { executionTargetError } from './execution-target-error'

const HASH = /^[a-f0-9]{64}$/
const MAX_TARGET_ID = 300
const MAX_FRAME = 1_310_720
// History snapshots are the signed source-version token
// `<archive>:<transcript>:<0|1>:<active>:<native>:<signature>` = 294 chars, so a
// 256-byte bound rejected every real turns page forwarded to an execution target.
const MAX_HISTORY_SNAPSHOT = 512
const OPS = new Set([
  'projects', 'directories', 'directoriesPage', 'providers', 'commands', 'sessions', 'sessionsPage', 'sessionAction',
  'workspace', 'fileDownload', 'history', 'historyPage', 'historyPreview', 'historyVersion', 'historyTurnsPage',
  'subscribe', 'submit', 'submitAtLog', 'intentStatusAtLog', 'output', 'answerQuestion', 'stop'
])

type DesktopTargetClient = {
  executionTargets(): Promise<ExecutionTargetRef[]>
  mobileRequest(target: { id: string; binding: string }, request: Record<string, unknown>, authorizePeer?: () => void): Promise<unknown>
  mobileSubmit(input: DesktopMobileTargetSubmit & { authorizePeer?: () => void }): Promise<unknown>
  mobileIntentStatus(input: { target: { id: string; binding: string }; phonePeerFingerprint: string; phoneIntentId: string; knownLogId?: string; authorizePeer?: () => void }): Promise<unknown>
}

export interface ExecutionTargetEnvelope {
  op: 'target'
  target: { id: string; binding: string }
  request: Record<string, unknown>
}

function fail(code: string): never { throw new Error(code) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function executionTargetPayloadHash(request: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(request)).digest('hex')
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) fail('invalid_target_request')
}

function validateWorkspaceQuery(value: unknown): void {
  if (!record(value) || typeof value.action !== 'string') fail('invalid_target_request')
  const keys = value.action === 'list' ? ['action', 'cwd', 'path', 'cursor']
    : value.action === 'file' ? ['action', 'cwd', 'path', 'offset', 'snapshot']
      : value.action === 'diff' ? ['action', 'cwd']
        : value.action === 'status' ? ['action', 'cwd', 'providerId', 'externalSessionId', 'agentProfileId'] : []
  if (keys.length === 0) fail('invalid_target_request')
  exact(value, keys)
  // Reuse the mobile read-only contract, including path="" for the workspace
  // root. Never substitute the broader desktop directory-selection parser.
  parseRemoteWorkspaceQuery(value)
}

function parseRequest(value: unknown): Record<string, unknown> {
  if (!record(value) || typeof value.op !== 'string' || !OPS.has(value.op)) fail('invalid_target_request')
  const op = value.op
  if (op === 'subscribe') {
    const subscribe = parseSubscribeFrame(value, 'target')
    if (!subscribe) fail('invalid_target_request')
    return { op, ...subscribe }
  }
  const keys: Record<string, string[]> = {
    projects: ['op'], providers: ['op'], sessions: ['op'],
    directories: ['op', 'path'], directoriesPage: ['op', 'path', 'cursor', 'limit', 'snapshot'],
    commands: ['op', 'providerId', 'cwd', 'agentProfileId'], sessionsPage: ['op', 'includeArchived', 'cursor', 'limit', 'snapshot'],
    workspace: ['op', 'query'], fileDownload: ['op', 'query'], sessionAction: ['op', 'context', 'action'],
    history: ['op', 'historyScope', 'providerId', 'cwd', 'externalSessionId', 'agentProfileId'], historyPage: ['op', 'historyScope', 'providerId', 'cwd', 'externalSessionId', 'agentProfileId', 'cursor', 'limit', 'snapshot'],
    historyPreview: ['op', 'historyScope', 'providerId', 'cwd', 'externalSessionId', 'agentProfileId'], historyVersion: ['op', 'historyScope', 'providerId', 'cwd', 'externalSessionId', 'agentProfileId'],
    historyTurnsPage: ['op', 'historyScope', 'providerId', 'cwd', 'externalSessionId', 'agentProfileId', 'before', 'limit', 'snapshot'],
    submit: ['op', 'intentId', 'detail', 'knownLogId'], submitAtLog: ['op', 'intentId', 'detail', 'knownLogId'],
    intentStatusAtLog: ['op', 'intentId', 'knownLogId'], output: ['op', 'runId', 'cursor'],
    answerQuestion: ['op', 'runId', 'answerId', 'response'], stop: ['op', 'runId']
  }
  exact(value, keys[op]!)
  if (op === 'submitAtLog' && !text(value.knownLogId, 128)) fail('invalid_target_request')
  if (op === 'directories' && value.path !== undefined && !text(value.path, 4096)) fail('invalid_target_request')
  if (op === 'directoriesPage') {
    if (value.path !== undefined && !text(value.path, 4096) || value.cursor !== undefined && (!integer(value.cursor) || value.cursor < 0) ||
        value.limit !== undefined && (!integer(value.limit) || value.limit < 1 || value.limit > 100) || value.snapshot !== undefined && !text(value.snapshot, 256)) fail('invalid_target_request')
  }
  if (op === 'commands' && (!text(value.providerId, 256) || !text(value.cwd, 16_384) || value.agentProfileId !== undefined && !text(value.agentProfileId, 256))) fail('invalid_target_request')
  if (op === 'sessionsPage' && (value.includeArchived !== undefined && typeof value.includeArchived !== 'boolean' || value.cursor !== undefined && (!integer(value.cursor) || value.cursor < 0) || value.limit !== undefined && (!integer(value.limit) || value.limit < 1 || value.limit > 100) || value.snapshot !== undefined && !text(value.snapshot, 256))) fail('invalid_target_request')
  if (['history', 'historyPage', 'historyPreview', 'historyVersion', 'historyTurnsPage'].includes(op) && (!text(value.providerId, 256) || !text(value.cwd, 16_384) || !text(value.externalSessionId, 256))) fail('invalid_target_request')
  if (op === 'historyPage' && (value.cursor !== undefined && (!integer(value.cursor) || value.cursor < 0) || value.limit !== undefined && (!integer(value.limit) || value.limit < 1 || value.limit > 256 * 1024) || value.snapshot !== undefined && !text(value.snapshot, MAX_HISTORY_SNAPSHOT))) fail('invalid_target_request')
  if (op === 'historyTurnsPage' && (value.before !== undefined && (!integer(value.before) || value.before < 0) || value.limit !== undefined && (!integer(value.limit) || value.limit < 1 || value.limit > 100) || value.snapshot !== undefined && !text(value.snapshot, MAX_HISTORY_SNAPSHOT))) fail('invalid_target_request')
  if ((op === 'submit' || op === 'submitAtLog') && (!text(value.intentId, 128) || !text(value.detail, MAX_FRAME) || value.knownLogId !== undefined && !text(value.knownLogId, 128))) fail('invalid_target_request')
  if (op === 'intentStatusAtLog' && (!text(value.intentId, 128) || value.knownLogId !== undefined && !text(value.knownLogId, 128))) fail('invalid_target_request')
  if (['output', 'stop'].includes(op) && !text(value.runId, 128)) fail('invalid_target_request')
  if (op === 'output' && (!integer(value.cursor) || value.cursor < 0)) fail('invalid_target_request')
  if (op === 'answerQuestion' && (!text(value.runId, 128) || !text(value.answerId, 128) || !record(value.response))) fail('invalid_target_request')
  if (op.startsWith('history')) {
    // A legacy forwarded request with an explicit Profile remains strict;
    // session display must opt in explicitly so an old host cannot be mistaken
    // for the mixed-provenance protocol.
    const scope = historyScopeSelection(value).historyScope ?? 'profile'
    if (scope === 'profile') historyProfileSelection(value, true)
    else historyProfileSelection(value)
  }
  if (op === 'workspace') validateWorkspaceQuery(value.query)
  if (op === 'fileDownload') parseRemoteFileDownloadQuery(value.query)
  if (op === 'submit' || op === 'submitAtLog') {
    let routing: unknown
    try { routing = JSON.parse(value.detail as string) } catch { fail('invalid_target_request') }
    if (!record(routing)) fail('invalid_target_request')
    // Swift JSONEncoder key order can differ after restart. Both the durable
    // hash and downstream ledger must see the same bytes for the same payload.
    return { ...structuredClone(value), detail: canonical(routing) }
  }
  return structuredClone(value)
}

export class ExecutionTargetRouter {
  readonly #authorizePeer: (peer: string) => void
  readonly #client: () => DesktopTargetClient
  readonly #gateway: { hostId: string; label: string }

  constructor(options: { authorizePeer(peer: string): void; client: DesktopTargetClient | (() => DesktopTargetClient); gateway: { hostId: string; label: string } }) {
    this.#authorizePeer = options.authorizePeer
    const client = options.client
    this.#client = typeof client === 'function' ? () => client() : () => client
    this.#gateway = options.gateway
  }

  async discovery(peer: string): Promise<{ executionTargets: { version: 1; gateway: { hostId: string; label: string }; targets: ExecutionTargetRef[] } }> {
    this.#authorizePeer(peer)
    const targets = await this.#client().executionTargets()
    this.#authorizePeer(peer)
    if (targets.length > 32) fail('execution_target_capacity_exceeded')
    return { executionTargets: { version: 1, gateway: this.#gateway, targets } }
  }

  async dispatch(peer: string, envelope: unknown): Promise<Record<string, unknown>> {
    this.#authorizePeer(peer)
    if (!record(envelope) || envelope.op !== 'target' || !record(envelope.target) || !text(envelope.target.id, MAX_TARGET_ID) || !HASH.test(String(envelope.target.binding))) fail('invalid_target')
    exact(envelope, ['op', 'target', 'request'])
    exact(envelope.target, ['id', 'binding'])
    const target = { id: envelope.target.id, binding: envelope.target.binding as string }
    const request = parseRequest(envelope.request)
    const op = request.op as string
    if (op === 'subscribe') {
      request.subscriptionId = createHash('sha256').update(peer).update(target.binding).digest('hex').slice(0, 32)
    }
    let response: unknown
    if (op === 'submit' || op === 'submitAtLog') {
      response = await this.#client().mobileSubmit({ target, phonePeerFingerprint: peer, phoneIntentId: request.intentId as string, payloadHash: executionTargetPayloadHash(request), request, authorizePeer: () => this.#authorizePeer(peer) })
    } else if (op === 'intentStatusAtLog') {
      response = await this.#client().mobileIntentStatus({ target, phonePeerFingerprint: peer, phoneIntentId: request.intentId as string,
        ...(typeof request.knownLogId === 'string' ? { knownLogId: request.knownLogId } : {}), authorizePeer: () => this.#authorizePeer(peer) })
    } else {
      response = await this.#client().mobileRequest(target, request, () => this.#authorizePeer(peer))
    }
    this.#authorizePeer(peer)
    if (!record(response)) fail('invalid_target_response')
    const { executionTarget: _existing, ...body } = response
    return { ...body, executionTarget: target }
  }
}
