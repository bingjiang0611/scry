import { chmod, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { readJson, writeJsonAtomic, writeTextAtomic } from './io.js'
import { RECORDER_VERSION } from './store.js'
import { handleRecorderHook, recorderEnablement } from './recorder.js'
import type { RecorderEnablement } from './config.js'
import { recorderSocketPath, PROTOCOL_VERSION, HOOK_EVENT_PATH } from './daemon-transport.js'
import { recorderOpenPath, recorderSessionRoot, withRecorderSessionLock, type RecorderOpenTurnState } from './runtime-state.js'
import { beginCaptureTurn } from './recorder-turn-state.js'
import { sessionIdOf, transcriptPathOf } from './recorder-contracts.js'
import { captureReceiverSource } from './session-capture-receiver.js'
import { recordCaptureRepositories } from './session-capture-discovery.js'
import { canonicalDataRoot, canonicalWorkspaceRoot, ensureWorkspaceConfig } from './session-capture-workspace.js'
import {
  CaptureRequestError,
  SESSION_CAPTURE_PROTOCOL,
  START_EVENT_NAMES,
  captureAck,
  captureContextPath,
  captureReceiverPath,
  captureStateContext,
  captureStatePath,
  captureWireContext,
  readCaptureState,
  type CaptureAck,
  type SessionCaptureContext,
  type SessionCaptureState
} from './session-capture-contract.js'

function captureTransport(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  workspaceRoot: string,
  provider: ProviderId,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  return {
    protocol: SESSION_CAPTURE_PROTOCOL,
    daemonProtocol: PROTOCOL_VERSION,
    recorderVersion: RECORDER_VERSION,
    socketPath: recorderSocketPath(workspaceRoot, env),
    eventPath: HOOK_EVENT_PATH,
    receiverPath: captureReceiverPath(enablement.dataRoot),
    contextPath: captureContextPath(enablement.dataRoot, provider, sessionId)
  }
}

/**
 * Claim a session. Idempotent per captureId: a repeated start adopts the recorded state instead of
 * opening a second generation, and a repeated delivery never moves the turn boundary.
 */
export async function startSessionCapture(args: {
  workspace: string
  provider: ProviderId
  sessionId: string
  dataDir: string
  context: SessionCaptureContext
  payload: Record<string, unknown>
  cli: { entry?: string; nodeDir?: string }
  env?: NodeJS.ProcessEnv
}): Promise<CaptureAck & { transport: Record<string, unknown> }> {
  const workspaceRoot = await canonicalWorkspaceRoot(args.workspace)
  const dataRoot = await canonicalDataRoot(workspaceRoot, args.dataDir)
  if (args.context.sessionId !== args.sessionId) {
    throw new CaptureRequestError('invalid_request', 'capture.sessionId does not match --session-id')
  }
  if (sessionIdOf(args.payload) !== args.sessionId) {
    throw new CaptureRequestError('invalid_request', 'hook payload does not belong to this session')
  }
  await ensureWorkspaceConfig(workspaceRoot, dataRoot)
  const enablement = await recorderEnablement(workspaceRoot, args.env)
  if (!enablement.enabled) throw new CaptureRequestError('recorder_unavailable', `recorder is not enabled: ${enablement.reason}`)
  const transcriptPath = transcriptPathOf(args.payload) ?? args.context.transcriptPath
  try {
    const info = await stat(transcriptPath)
    if (!info.isFile()) throw new Error('not a regular file')
  } catch {
    throw new CaptureRequestError('recorder_unavailable', 'the host transcript is not readable')
  }
  const transport = captureTransport(enablement, workspaceRoot, args.provider, args.sessionId, args.env)
  const statePath = captureStatePath(enablement.dataRoot, args.provider, args.sessionId)
  const existing = await readCaptureState(enablement.dataRoot, args.provider, args.sessionId)
  if (existing && existing.captureId === args.context.captureId) {
    await ensureReceiver(enablement, workspaceRoot, args.provider, args.cli, args.env)
    return { status: 'already_started', ack: captureAck('start', 'already_started', args.context), transport }
  }
  const state: SessionCaptureState = {
    ...args.context,
    schemaVersion: 1,
    workspaceRoot,
    dataRoot: enablement.dataRoot,
    transcriptPath: resolve(transcriptPath)
  }
  await withRecorderSessionLock(enablement.dataRoot, args.provider, args.sessionId, async () => {
    await beginCaptureTurn(enablement, args.provider, args.sessionId, args.context, state.transcriptPath, args.payload)
    await writeJsonAtomic(statePath, state)
    await writeJsonAtomic(captureContextPath(enablement.dataRoot, args.provider, args.sessionId), captureWireContext(args.context))
  }, { waitMs: 10_000 })
  await ensureReceiver(enablement, workspaceRoot, args.provider, args.cli, args.env)
  return { status: 'started', ack: captureAck('start', 'started', args.context), transport }
}

async function ensureReceiver(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  workspaceRoot: string,
  provider: ProviderId,
  cli: { entry?: string; nodeDir?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const path = captureReceiverPath(enablement.dataRoot)
  const source = captureReceiverSource({
    socketPath: recorderSocketPath(workspaceRoot, env),
    workspace: workspaceRoot,
    provider,
    dataDir: enablement.dataRoot,
    eventPath: HOOK_EVENT_PATH,
    recorderVersion: RECORDER_VERSION,
    cli
  })
  await writeTextAtomic(path, source, { sync: false })
  await chmod(path, 0o700).catch(() => undefined)
}

/**
 * Stop accepting work for this session after the current turn finishes. The daemon keeps running
 * and other sessions are untouched. The turn boundary is frozen here, so a transcript that grows
 * with the next prompt can never be read back into this turn.
 */
export async function stopSessionCapture(args: {
  workspace: string
  provider: ProviderId
  sessionId: string
  dataDir: string
  context: SessionCaptureContext
  env?: NodeJS.ProcessEnv
}): Promise<CaptureAck> {
  const dataRoot = await canonicalDataRoot(args.workspace, args.dataDir)
  if (args.context.sessionId !== args.sessionId) {
    throw new CaptureRequestError('invalid_request', 'capture.sessionId does not match --session-id')
  }
  const state = await readCaptureState(dataRoot, args.provider, args.sessionId)
  if (!state || state.captureId !== args.context.captureId) {
    return { status: 'inactive', ack: captureAck('stop', 'inactive', args.context) }
  }
  if (state.stopRequestedAt) {
    return { status: 'already_stopping', ack: captureAck('stop', 'already_stopping', args.context) }
  }
  const requestedAt = args.context.stopRequestedAt ?? new Date().toISOString()
  await withRecorderSessionLock(dataRoot, args.provider, args.sessionId, async () => {
    await writeJsonAtomic(captureStatePath(dataRoot, args.provider, args.sessionId), {
      ...state,
      stopRequestedAt: requestedAt,
      stoppedAt: new Date().toISOString()
    } satisfies SessionCaptureState)
    const root = recorderSessionRoot(dataRoot, args.provider, args.sessionId)
    const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
    if (!open) return
    const size = open.transcriptPath
      ? await stat(open.transcriptPath).then((info) => info.size).catch(() => null)
      : null
    await writeJsonAtomic(recorderOpenPath(root), {
      ...open,
      captureStopRequestedAt: requestedAt,
      ...(size == null ? {} : { captureTranscriptEndOffset: size })
    }, { sync: false })
  }, { waitMs: 10_000 })
  return { status: 'stopping', ack: captureAck('stop', 'stopping', args.context) }
}

/** The session hook path: only ever applies events for the session that claimed itself. */
export async function applySessionCaptureHook(args: {
  workspace: string
  provider: ProviderId
  event: string
  sessionId?: string
  dataDir: string
  /** Omitted on delivery: the session names the claim, and the state written at start proves it. */
  context?: SessionCaptureContext
  payload: Record<string, unknown>
  queueOnly?: boolean
  deferDelivery?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<CaptureAck & { reason?: string }> {
  const dataRoot = await canonicalDataRoot(args.workspace, args.dataDir)
  const sessionId = args.sessionId ?? sessionIdOf(args.payload)
  if (!sessionId) throw new CaptureRequestError('invalid_request', 'the hook payload names no session')
  if (sessionIdOf(args.payload) !== sessionId) {
    throw new CaptureRequestError('invalid_request', 'hook payload does not belong to this session')
  }
  const state = await readCaptureState(dataRoot, args.provider, sessionId)
  if (!state) {
    // Opt-in means ordinary sessions in this workspace reach no claim. Nothing was applied, and the
    // caller must not retry: there is nothing to record.
    const ack = { protocol: SESSION_CAPTURE_PROTOCOL, action: 'hook', status: 'ignored', captureId: null, sessionId }
    return { status: 'ignored', ack, reason: 'no capture is open for this session' }
  }
  const context = args.context ?? captureStateContext(state)
  if (context.sessionId !== sessionId) {
    throw new CaptureRequestError('invalid_request', 'capture.sessionId does not match --session-id')
  }
  if (state.captureId !== context.captureId) {
    throw new CaptureRequestError('invalid_request', 'no active capture for this session and captureId')
  }
  const enablement = await recorderEnablement(args.workspace, args.env)
  if (!enablement.enabled) throw new CaptureRequestError('recorder_unavailable', `recorder is not enabled: ${enablement.reason}`)
  if (state.stopRequestedAt && START_EVENT_NAMES.has(args.event)) {
    // The next turn must not be recorded even if the host still delivers its start event.
    return {
      status: 'accepted',
      ack: { ...captureAck('hook', 'accepted', context), recorded: false, reason: 'capture stopped' },
      reason: 'capture stopped'
    }
  }
  const result = await handleRecorderHook({
    provider: args.provider,
    event: args.event,
    workspace: args.workspace,
    payload: args.payload,
    capture: captureStateContext(state),
    queueOnly: args.queueOnly,
    deferDelivery: args.deferDelivery,
    env: args.env
  })
  // The edited file names the repository; its PreToolUse arrives before the write, so the baseline
  // taken here is the pre-edit state.
  if (args.event === 'PreToolUse') await recordCaptureRepositories(enablement, args.provider, sessionId, args.payload)
  return {
    status: 'accepted',
    ack: {
      ...captureAck('hook', 'accepted', context),
      recorded: result.status !== 'disabled' && result.status !== 'ignored',
      result: result.status
    }
  }
}
