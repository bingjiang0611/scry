import { AsyncLocalStorage } from 'node:async_hooks'
import type { RunControlHandlers } from './host-run-control'
import type { AppEventFeed } from './app-event-feed'
import { DAEMON_LOCAL_OP_CHANNELS, DAEMON_LOCAL_OP_NAMES } from '../daemon-channel-gate'
import { SUBSCRIBE_VIEWS, type SubscribeResponse, type SubscribeRequest, type SubscribeView } from '../../shared/orchestration-subscribe'
import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'

// One App channel handler, called with the renderer's arguments as main would have.
export type LocalOpHandler = (...args: unknown[]) => unknown
// Keyed `${op}:${method}`.
export type LocalOpHandlers = ReadonlyMap<string, LocalOpHandler>

/**
 * Work the host serves on its local (App) endpoint only. A paired device reaching the
 * network endpoint gets `unsupported_op` for all of it, not an answer from this table.
 */
export interface LocalEndpointHandlers {
  runControl?: RunControlHandlers
  localOps?: LocalOpHandlers
  // What the daemon tells its App that no run read carries (P3f).
  events?: Pick<AppEventFeed, 'read'>
  // Authoritative orchestration subscribe handler. The network shares only this read op.
  subscribe?: (peer: string, request: SubscribeRequest, signal?: AbortSignal) => Promise<SubscribeResponse>
  // The App viewed one of the daemon's unread sessions (E1b).
  attention?: { viewed(sessionKey: string): void }
  // The App's terminal output and lifetime (P3-terminal.md).
  terminal?: {
    read(cursor?: string): unknown
    detachRenderer(): void
    shutdown(): Promise<void>
  }
  // Daemon-to-App pull/reply bridge for ExecutionTargetRouter (W10).
  executionTargetBridge?: {
    poll(peer: string, waitMs: number, signal?: AbortSignal): Promise<{ calls: unknown[] }>
    submitResult(peer: string, input: { callId: string; ok: boolean; result?: unknown; error?: string }): { accepted: boolean }
  }
}

const TERMINAL_FEED_KEYS = ['op', 'keepAlive', 'protocol', 'method', 'cursor']

/** The App reads its terminal output by cursor, detaches its window, or quits; absent on the network endpoint. */
export async function handleTerminalFeed(terminal: LocalEndpointHandlers['terminal'], request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!terminal) return { error: 'unsupported_op' }
  const { method, cursor } = request
  if (Object.keys(request).some((key) => !TERMINAL_FEED_KEYS.includes(key))) return { error: 'invalid_request' }
  if (method === 'read') {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 128)) return { error: 'invalid_request' }
    return { terminal: terminal.read(cursor as string | undefined) }
  }
  if (cursor !== undefined) return { error: 'invalid_request' }
  if (method === 'detachRenderer') { terminal.detachRenderer(); return { terminal: true } }
  if (method === 'shutdown') { await terminal.shutdown(); return { terminal: true } }
  return { error: 'invalid_request' }
}

const MAX_SESSION_KEY = 4096

/** Idempotent: viewing a session that is not unread changes nothing. */
export function handleAttentionViewed(attention: LocalEndpointHandlers['attention'], request: Record<string, unknown>): Record<string, unknown> {
  if (!attention) return { error: 'unsupported_op' }
  const { sessionKey } = request
  if (Object.keys(request).some((key) => !['op', 'keepAlive', 'protocol', 'sessionKey'].includes(key)) ||
    typeof sessionKey !== 'string' || sessionKey.length === 0 || sessionKey.length > MAX_SESSION_KEY) return { error: 'invalid_request' }
  attention.viewed(sessionKey)
  return { viewed: true }
}

const EVENT_KEYS = ['op', 'keepAlive', 'protocol', 'epoch', 'cursor', 'waitMs']

/** The App's long poll on the event feed; absent on the network endpoint. */
export async function handleAppEvents(events: LocalEndpointHandlers['events'], request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!events) return { error: 'unsupported_op' }
  const { cursor, waitMs, epoch } = request
  if (Object.keys(request).some((key) => !EVENT_KEYS.includes(key)) ||
    !Number.isSafeInteger(cursor) || (cursor as number) < 0 || !Number.isSafeInteger(waitMs) || (waitMs as number) < 0 ||
    (epoch !== undefined && (typeof epoch !== 'string' || epoch.length === 0 || epoch.length > 64))) return { error: 'invalid_request' }
  return { events: await events.read({ cursor: cursor as number, waitMs: waitMs as number, ...(epoch !== undefined ? { epoch: epoch as string } : {}) }) }
}

const SUBSCRIBE_KEYS = ['op', 'keepAlive', 'protocol', 'views', 'session', 'known', 'sessionsCursor', 'detailWatch', 'waitMs', 'eventSet', 'chunk', 'deviceLabel']

/** Bounds the subscribe frame before it reaches the authoritative reader. */
export async function handleSubscribe(
  subscribe: LocalEndpointHandlers['subscribe'],
  request: Record<string, unknown>,
  peer: string,
  signal?: AbortSignal,
  network = false
): Promise<Record<string, unknown>> {
  if (!subscribe) return { error: 'unsupported_op' }
  if (Object.keys(request).some((key) => !SUBSCRIBE_KEYS.includes(key))) return { error: 'invalid_request' }
  const { views, session, known, sessionsCursor, detailWatch, waitMs, eventSet, chunk } = request
  if (!Array.isArray(views) || views.length === 0 || views.length > 3 ||
      !views.every((v): v is SubscribeView => typeof v === 'string' && SUBSCRIBE_VIEWS.has(v as SubscribeView))) {
    return { error: 'invalid_request' }
  }
  if (!Number.isSafeInteger(waitMs) || (waitMs as number) < 0) return { error: 'invalid_request' }
  if (eventSet !== undefined && (!Number.isSafeInteger(eventSet) || (eventSet as number) < 1)) return { error: 'invalid_request' }
  if (sessionsCursor !== undefined && (typeof sessionsCursor !== 'string' || sessionsCursor.length === 0 || sessionsCursor.length > 512)) {
    return { error: 'invalid_request' }
  }
  let parsedSession: SubscribeRequest['session']
  if (session !== undefined) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return { error: 'invalid_request' }
    const s = session as Record<string, unknown>
    if (typeof s.sessionKey !== 'string' || s.sessionKey.length === 0 || s.sessionKey.length > 4096) return { error: 'invalid_request' }
    parsedSession = {
      sessionKey: s.sessionKey,
      ...(typeof s.providerId === 'string' ? { providerId: s.providerId } : {}),
      ...(typeof s.agentProfileId === 'string' ? { agentProfileId: s.agentProfileId } : {}),
      ...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}),
      ...(typeof s.externalSessionId === 'string' ? { externalSessionId: s.externalSessionId } : {})
    }
  }
  if (views.includes('detail') && !parsedSession) return { error: 'invalid_request' }
  if (network && (detailWatch !== undefined || (views.includes('detail') && views.length !== 1))) return { error: 'invalid_request' }
  if (detailWatch !== undefined && (!views.includes('detail') || chunk !== undefined ||
      (detailWatch !== 'open' && detailWatch !== 'continue'))) return { error: 'invalid_request' }
  let parsedChunk: SubscribeRequest['chunk']
  if (chunk !== undefined) {
    if (!views.includes('detail') || !chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return { error: 'invalid_request' }
    const { id, offset } = chunk as Record<string, unknown>
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id) || typeof offset !== 'number' ||
        offset <= 0 || offset >= DESKTOP_HISTORY_MAX_BYTES || offset % DESKTOP_HISTORY_CHUNK_BYTES !== 0) {
      return { error: 'invalid_request' }
    }
    parsedChunk = { id, offset }
  }
  let parsedKnown: SubscribeRequest['known']
  if (known !== undefined) {
    if (!known || typeof known !== 'object' || Array.isArray(known)) return { error: 'invalid_request' }
    const k = known as Record<string, unknown>
    if (typeof k.hostId !== 'string' || k.hostId.length === 0 || k.hostId.length > 128 ||
        typeof k.logId !== 'string' || k.logId.length === 0 || k.logId.length > 128 ||
        !Number.isSafeInteger(k.seq) || (k.seq as number) < 0) {
      return { error: 'invalid_request' }
    }
    parsedKnown = { hostId: k.hostId, logId: k.logId, seq: k.seq as number }
  }
  const reply = await subscribe(peer, {
    views,
    waitMs: waitMs as number,
    ...(parsedSession ? { session: parsedSession } : {}),
    ...(parsedKnown ? { known: parsedKnown } : {}),
    ...(parsedChunk ? { chunk: parsedChunk } : {}),
    ...(detailWatch ? { detailWatch } : {}),
    ...(sessionsCursor !== undefined ? { sessionsCursor: sessionsCursor as string } : {}),
    ...(eventSet !== undefined ? { eventSet: eventSet as number } : {})
  }, signal)
  return { subscribe: reply }
}

const TARGET_WORK_KEYS = ['op', 'keepAlive', 'protocol', 'waitMs']
const TARGET_RESULT_KEYS = ['op', 'keepAlive', 'protocol', 'callId', 'ok', 'result', 'error']

/** The primary App's long poll for forwarded execution-target calls; absent on the network endpoint. */
export async function handleExecutionTargetWork(
  bridge: LocalEndpointHandlers['executionTargetBridge'],
  request: Record<string, unknown>,
  peer: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  if (!bridge) return { error: 'unsupported_op' }
  const { waitMs } = request
  if (Object.keys(request).some((key) => !TARGET_WORK_KEYS.includes(key)) ||
    !Number.isSafeInteger(waitMs) || (waitMs as number) < 0) return { error: 'invalid_request' }
  return await bridge.poll(peer, waitMs as number, signal)
}

/** The primary App's reply to a forwarded execution-target call; absent on the network endpoint. */
export function handleExecutionTargetResult(
  bridge: LocalEndpointHandlers['executionTargetBridge'],
  request: Record<string, unknown>,
  peer: string
): Record<string, unknown> {
  if (!bridge) return { error: 'unsupported_op' }
  const { callId, ok, result, error } = request
  if (Object.keys(request).some((key) => !TARGET_RESULT_KEYS.includes(key)) ||
    typeof callId !== 'string' || callId.length === 0 || callId.length > 128 ||
    typeof ok !== 'boolean' ||
    (error !== undefined && (typeof error !== 'string' || error.length === 0 || error.length > 256))) {
    return { error: 'invalid_request' }
  }
  return bridge.submitResult(peer, {
    callId,
    ok,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {})
  })
}

const MAX_ARGS = 4

export function isLocalOp(op: unknown): op is string {
  return typeof op === 'string' && DAEMON_LOCAL_OP_NAMES.has(op)
}

/**
 * Build the local-op table from the channel handlers main registers. Every channel in
 * DAEMON_LOCAL_OP_CHANNELS must be present: a missing handler would turn a channel the
 * App forwards into a silent gap, so assembly fails instead.
 */
export function localOpHandlersFor(channels: Readonly<Record<string, LocalOpHandler>>): LocalOpHandlers {
  const table = new Map<string, LocalOpHandler>()
  for (const [channel, { op, method }] of Object.entries(DAEMON_LOCAL_OP_CHANNELS)) {
    const handler = channels[channel]
    if (!handler) throw new Error(`local_op_handler_missing:${channel}`)
    table.set(`${op}:${method}`, handler)
  }
  return table
}

// The verified grant behind the local op being served. A handler that writes on the
// caller's behalf (a conversation send records a ledger intent) needs the caller's own
// identity, not a guess at "the App": the local endpoint may hold more than one grant.
const caller = new AsyncLocalStorage<{ peer: string }>()

/** The peer whose local op is running, or undefined outside one. */
export function localOpCaller(): string | undefined {
  return caller.getStore()?.peer
}

export async function handleLocalOp(handlers: LocalOpHandlers | undefined, request: Record<string, unknown>, peer: string): Promise<Record<string, unknown>> {
  if (!handlers) return { error: 'unsupported_op' }
  if (Object.keys(request).some((key) => !['op', 'keepAlive', 'protocol', 'method', 'args', 'absent'].includes(key))) return { error: 'invalid_request' }
  const args = request.args ?? []
  if (typeof request.method !== 'string' || !Array.isArray(args) || args.length > MAX_ARGS) return { error: 'invalid_request' }
  // Positions the caller left out (undefined), which JSON could only carry as null.
  const absent = request.absent ?? []
  if (!Array.isArray(absent) || absent.length > args.length || new Set(absent).size !== absent.length ||
    absent.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= args.length)) return { error: 'invalid_request' }
  for (const index of absent as number[]) args[index] = undefined
  const handler = handlers.get(`${request.op as string}:${request.method}`)
  if (!handler) return { error: 'unsupported_op' }
  // JSON has no undefined; a handler that returns nothing answers null.
  return { result: (await caller.run({ peer }, () => handler(...args))) ?? null }
}
