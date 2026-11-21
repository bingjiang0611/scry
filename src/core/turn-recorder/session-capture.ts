import { chmod, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { readJson, writeJsonAtomic, writeTextAtomic } from './io.js'
import { RECORDER_VERSION } from './store.js'
import { handleRecorderHook, recorderEnablement } from './recorder.js'
import { resolveCommitHookActivation } from './commit-hook-grant.js'
import type { RecorderEnablement } from './config.js'
import { recorderSocketPath, PROTOCOL_VERSION, HOOK_EVENT_PATH } from './daemon-transport.js'
import { recorderOpenPath, recorderSessionRoot, withRecorderSessionLock, type RecorderOpenTurnState } from './runtime-state.js'
import { captureTurnInitializationIssue, beginCaptureTurn } from './recorder-turn-state.js'
import { sessionIdOf, transcriptPathOf } from './recorder-contracts.js'
import { captureReceiverSource } from './session-capture-receiver.js'
import { recorderInboxHasCaptureCommand } from './inbox.js'
import { recordCaptureRepositories } from './session-capture-discovery.js'
import { canonicalDataRoot, canonicalWorkspaceRoot, ensureWorkspaceConfig } from './session-capture-workspace.js'
import {
  CaptureRequestError,
  SESSION_CAPTURE_PROTOCOL,
  START_EVENT_NAMES,
  captureAck,
  captureContextPath,
  captureInboxContract,
  captureReceiverPath,
  captureStateContext,
  captureStatePath,
  captureWireContext,
  readCaptureState,
  unionDiffExclude,
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
    contextPath: captureContextPath(enablement.dataRoot, provider, sessionId),
    inbox: captureInboxContract(enablement.dataRoot, provider, sessionId)
  }
}

/**
 * Everything a claim must prove before any turn is opened: a readable transcript, an enabled recorder,
 * a writable capture root and this capture's resolved exclusion paths. A deferred claim validates the
 * same evidence when it is queued, so an integrator learns about a refusal before the daemon runs.
 */
export interface PreparedCaptureStart {
  enablement: Extract<RecorderEnablement, { enabled: true }>
  workspaceRoot: string
  provider: ProviderId
  sessionId: string
  context: SessionCaptureContext
  state: SessionCaptureState
  payload: Record<string, unknown>
  ancestryFromPid?: number
  hostChain?: import('./host-process.js').HostProcess[]
  transport: Record<string, unknown>
}

export async function prepareCaptureStart(args: {
  workspace: string
  provider: ProviderId
  sessionId: string
  dataDir: string
  context: SessionCaptureContext
  payload: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  ancestryFromPid?: number
  hostChain?: import('./host-process.js').HostProcess[]
}): Promise<PreparedCaptureStart> {
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
  // The host tells us its commit callback exactly once, in this process. Record it now: the turns this
  // capture produces are committed later by the daemon and the hook receiver, which never inherit the
  // host's environment and would otherwise find no callback at all.
  if ((args.env ?? process.env).SCRY_RECORDER_COMMIT_HOOK?.trim()) {
    await resolveCommitHookActivation(workspaceRoot, enablement.config, args.env ?? process.env)
  }
  const transcriptPath = transcriptPathOf(args.payload) ?? args.context.transcriptPath
  try {
    const info = await stat(transcriptPath)
    if (!info.isFile()) throw new Error('not a regular file')
  } catch {
    throw new CaptureRequestError('recorder_unavailable', 'the host transcript is not readable')
  }
  const transport = captureTransport(enablement, workspaceRoot, args.provider, args.sessionId, args.env)
  const context = await resolveDiffExclude(args.context)
  const state: SessionCaptureState = {
    ...context,
    schemaVersion: 1,
    workspaceRoot,
    dataRoot: enablement.dataRoot,
    transcriptPath: resolve(transcriptPath)
  }
  return {
    enablement, workspaceRoot, provider: args.provider, sessionId: args.sessionId, context, state,
    payload: args.payload, transport,
    ...(args.ancestryFromPid ? { ancestryFromPid: args.ancestryFromPid } : {}),
    ...(args.hostChain ? { hostChain: args.hostChain } : {})
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
  /** Pid of the process that asked for the capture; the turn records the chain above it. */
  ancestryFromPid?: number
  /**
   * Host processes the caller already resolved. A queued claim is replayed by a daemon that is not on
   * the host's process chain, and the claimant's own pid may be gone by then.
   */
  hostChain?: import('./host-process.js').HostProcess[]
  /**
   * The caller already holds this session's recording lock: the inbox drain applies queued claims in
   * arrival order inside the pass that owns it. Taking the lock again would deadlock the drain.
   */
  sessionLockHeld?: boolean
}): Promise<CaptureAck & { transport: Record<string, unknown> }> {
  const prepared = await prepareCaptureStart(args)
  const { enablement, workspaceRoot, provider, sessionId, context, state } = prepared
  const statePath = captureStatePath(enablement.dataRoot, provider, sessionId)
  let warning: string | undefined
  const apply = async (): Promise<'started' | 'already_started'> => {
    const existing = await readCaptureState(enablement.dataRoot, provider, sessionId)
    if (existing && existing.captureId === context.captureId) {
      warning = await adoptDiffExclude(enablement, provider, sessionId, existing, context.diffExclude)
      return 'already_started' as const
    }
    await beginCaptureTurn(
      enablement, provider, sessionId, context, state.transcriptPath, prepared.payload,
      prepared.ancestryFromPid, prepared.hostChain
    )
    await writeJsonAtomic(statePath, state)
    await writeJsonAtomic(captureContextPath(enablement.dataRoot, provider, sessionId), captureWireContext(context))
    return 'started' as const
  }
  const status = args.sessionLockHeld
    ? await apply()
    : await withRecorderSessionLock(enablement.dataRoot, provider, sessionId, apply, { waitMs: 10_000 })
  await ensureReceiver(enablement, workspaceRoot, provider, args.cli, args.env)
  return {
    status,
    ack: { ...captureAck('start', status, context), ...(warning ? { warning } : {}) },
    transport: prepared.transport
  }
}

/**
 * A repeated start of this capture may only add exclusion paths: a later stage of the same workflow
 * can never narrow what an earlier one asked for. The union is written to the session state, the
 * published context and the open turn, which are the places the diff path reads it from.
 */
async function adoptDiffExclude(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionId: string,
  state: SessionCaptureState,
  added: string[] | undefined
): Promise<string | undefined> {
  // Caller holds the session lock. Repair all publications even when the control file already
  // contains the union: a previous process may have stopped between these durable writes.
  const root = recorderSessionRoot(enablement.dataRoot, provider, sessionId)
  const open = await readJson<RecorderOpenTurnState>(recorderOpenPath(root))
  // The claim is already active. Report this turn's missing baseline without disabling the session.
  const warning = open ? captureTurnInitializationIssue(open, enablement) : undefined
  const openCapture = open?.capture?.captureId === state.captureId ? open.capture : undefined
  const merged = unionDiffExclude(unionDiffExclude(state.diffExclude, openCapture?.diffExclude), added)
  // Keep the session-level union first: it must survive even if Stop removes the open turn
  // before an interrupted publication is retried. A preceding capture's exclusions stay there.
  if (merged.length !== (state.diffExclude?.length ?? 0)) {
    await writeJsonAtomic(captureStatePath(enablement.dataRoot, provider, sessionId),
      { ...state, diffExclude: merged } satisfies SessionCaptureState)
  }
  if (open && openCapture && merged.length) {
    await writeJsonAtomic(recorderOpenPath(root),
      { ...open, capture: { ...openCapture, diffExclude: merged } })
  }
  await writeJsonAtomic(captureContextPath(enablement.dataRoot, provider, sessionId),
    captureWireContext({ ...captureStateContext(state), diffExclude: merged }))
  return warning
}

/**
 * A declared path comes from the integrator's own shell, so it can reach this workspace through a
 * symlink (`/var` and `/private/var` are one directory). Resolve each path once, before it is stored:
 * the diff comparison against the repository root Git reports is lexical. A path that does not exist
 * yet keeps its declared form and simply excludes nothing until it does.
 */
async function resolveDiffExclude(context: SessionCaptureContext): Promise<SessionCaptureContext> {
  if (!context.diffExclude?.length) return context
  const paths = await Promise.all(context.diffExclude.map(async (path) => realpath(path).catch(() => path)))
  return { ...context, diffExclude: [...new Set(paths)] }
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
  /** The caller already holds this session's recording lock; see `startSessionCapture`. */
  sessionLockHeld?: boolean
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
  const applyStop = async (): Promise<void> => {
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
  }
  if (args.sessionLockHeld) await applyStop()
  else await withRecorderSessionLock(dataRoot, args.provider, args.sessionId, applyStop, { waitMs: 10_000 })
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
  /** Delivered in capture mode; see `RecorderHookInput.captureMode`. */
  captureMode?: boolean
  env?: NodeJS.ProcessEnv
  /** Pid of the process that delivered this hook, when the transport knows it. */
  ancestryFromPid?: number
}): Promise<CaptureAck & { reason?: string }> {
  const dataRoot = await canonicalDataRoot(args.workspace, args.dataDir)
  const sessionId = args.sessionId ?? sessionIdOf(args.payload)
  if (!sessionId) throw new CaptureRequestError('invalid_request', 'the hook payload names no session')
  if (sessionIdOf(args.payload) !== sessionId) {
    throw new CaptureRequestError('invalid_request', 'hook payload does not belong to this session')
  }
  const state = await readCaptureState(dataRoot, args.provider, sessionId)
  if (!state) {
    // A deferred claim writes its entry first and publishes the state when the daemon applies it, so
    // an event queued in between has no capture to name yet. It is accepted only while that claim is
    // still waiting in this session's own inbox; nothing is applied here either way.
    const claimWaiting = args.queueOnly === true &&
      await recorderInboxHasCaptureCommand(recorderSessionRoot(dataRoot, args.provider, sessionId))
    if (!claimWaiting) {
      // Opt-in means ordinary sessions in this workspace reach no claim. Nothing was applied, and the
      // caller must not retry: there is nothing to record.
      const ack = { protocol: SESSION_CAPTURE_PROTOCOL, action: 'hook', status: 'ignored', captureId: null, sessionId }
      return { status: 'ignored', ack, reason: 'no capture is open for this session' }
    }
    const queued = await handleRecorderHook({
      provider: args.provider,
      event: args.event,
      workspace: args.workspace,
      payload: args.payload,
      queueOnly: true,
      captureMode: true,
      deferDelivery: true,
      env: args.env,
      ...(args.ancestryFromPid ? { ancestryFromPid: args.ancestryFromPid } : {})
    })
    return {
      status: 'accepted',
      ack: {
        protocol: SESSION_CAPTURE_PROTOCOL, action: 'hook', status: 'queued',
        captureId: null, sessionId, recorded: true, result: queued.status
      },
      reason: 'capture claim is still queued; the event follows it in the inbox'
    }
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
    ...(args.queueOnly ? { queueOnly: true, captureMode: true } : {}),
    deferDelivery: args.deferDelivery,
    env: args.env,
    ...(args.ancestryFromPid ? { ancestryFromPid: args.ancestryFromPid } : {})
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
