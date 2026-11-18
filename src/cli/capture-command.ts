import { basename, dirname, join } from 'node:path'
import { type ParsedArgs, flag, providerOf, readStdin, workspaceOf } from './command-args.js'
import { notifyRecorderInbox, startRecorderDaemon } from '../core/turn-recorder/daemon.js'
import { RECORDER_VERSION } from '../core/turn-recorder/store.js'
import { captureStatePath, SESSION_CAPTURE_PROTOCOL, captureReceiverPath } from '../core/turn-recorder/session-capture-contract.js'
import {
  CaptureRequestError,
  captureExitCode,
  parseCaptureEnvelope,
  parseHookPayload,
  parseSessionCaptureContext,
  type SessionCaptureContext
} from '../core/turn-recorder/session-capture-contract.js'
import {
  applySessionCaptureHook,
  prepareCaptureStart,
  startSessionCapture,
  stopSessionCapture
} from '../core/turn-recorder/session-capture.js'
import { queueCaptureCommand, queueHook } from '../core/turn-recorder/recorder-hook-queue.js'

/**
 * Session-capture delivery. `--capture-mode` must be explicit: silently accepting the flag and then
 * applying an ordinary hook would make an opt-in workspace record sessions nobody opened.
 *
 * `--queue-only` is the durable path a host hook uses when it may not spend its own five seconds on
 * recorder work: the event is written to this session's inbox and a daemon applies it later.
 */
export async function sessionHookCommand(args: ParsedArgs): Promise<number> {
  const mode = flag(args, 'capture-mode')
  let context: SessionCaptureContext | undefined
  try {
    if (mode !== 'session') throw new CaptureRequestError('unsupported_capture', `unsupported capture mode: ${String(mode)}`)
    const event = flag(args, 'event')
    if (!event) throw new CaptureRequestError('invalid_request', '--event is required')
    const provider = providerOf(args)
    const payload = parseHookPayload(await readStdin())
    const dataDir = flag(args, 'data-dir')
    if (!dataDir) throw new CaptureRequestError('invalid_request', '--data-dir is required for session capture')
    const queueOnly = args.flags.has('queue-only') || process.env.SCRY_RECORDER_DAEMON_TRIED === '1'
    const result = await applySessionCaptureHook({
      workspace: workspaceOf(args),
      provider,
      event,
      dataDir,
      ...(flag(args, 'session-id') ? { sessionId: flag(args, 'session-id') } : {}),
      payload,
      queueOnly,
      captureMode: true,
      // This process was started by the hook script, so its parent is the host's chain.
      ancestryFromPid: process.ppid
    })
    if (queueOnly) {
      // The entry is durable; waking a recorder is a notification, never a wait for its outcome.
      await notifyRecorderInbox({ workspace: workspaceOf(args), scriptPath: process.argv[1] })
    } else {
      // The receiver only falls back when the daemon did not apply this event: no daemon, or one from
      // another recorder version that refused the handshake. Start ours so the rest of the session
      // uses the fast path; an unknown delivery is never a reason to replace a live peer.
      const daemonEnabled = process.env.SCRY_RECORDER_TRANSPORT !== 'direct'
      if (daemonEnabled && process.env.SCRY_RECORDER_DAEMON_TRIED !== '1'
        && result.status !== 'ignored' && process.argv[1]) {
        await startRecorderDaemon({ workspace: workspaceOf(args), scriptPath: process.argv[1], waitForReady: false }).catch(() => undefined)
      }
    }
    process.stdout.write(`${JSON.stringify(result.ack)}\n`)
    return 0
  } catch (error) {
    return captureFailure('hook', context, error)
  }
}

/** Error ACKs stay machine-readable; stderr is diagnostics, never the contract. */
function captureFailure(action: 'start' | 'stop' | 'hook', context: SessionCaptureContext | undefined, error: unknown): number {
  if (!(error instanceof CaptureRequestError)) throw error
  process.stdout.write(`${JSON.stringify({
    protocol: SESSION_CAPTURE_PROTOCOL,
    action,
    status: 'error',
    captureId: context?.captureId ?? null,
    sessionId: context?.sessionId ?? null,
    code: error.code
  })}\n`)
  process.stderr.write(`scry recorder capture: ${error.message}\n`)
  return captureExitCode(error.code)
}

/** The chain a claimant resolved, as JSON on the command line: `[{"pid":1,"token":"…"}]`. */
function hostChainOf(args: ParsedArgs): unknown {
  const raw = flag(args, 'host-chain')
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new CaptureRequestError('invalid_request', '--host-chain must be a JSON array')
  }
}

/**
 * CodeLens opens and closes a session here; the recorder owns the turn boundary it implies.
 *
 * `--defer` writes the claim to the inbox instead of applying it. The hook that proved the session
 * returns inside its own five seconds, and the daemon opens the turn, takes the Git baseline and
 * replays the events that arrived in between, in arrival order.
 */
export async function captureCommand(args: ParsedArgs): Promise<number> {
  const action = args.positionals[2]
  let context: SessionCaptureContext | undefined
  try {
    if (action !== 'start' && action !== 'stop') {
      throw new CaptureRequestError('invalid_request', 'usage: scry recorder capture start|stop [options]')
    }
    const provider = providerOf(args)
    const envelope = parseCaptureEnvelope(await readStdin())
    context = parseSessionCaptureContext(envelope.context, provider)
    const sessionId = flag(args, 'session-id') ?? context.sessionId
    const dataDir = flag(args, 'data-dir')
    const workspace = workspaceOf(args)
    if (!dataDir) throw new CaptureRequestError('invalid_request', '--data-dir is required for session capture')
    if (args.flags.has('defer')) {
      // The same evidence is proved for both actions: the claim is only accepted when the recorder is
      // enabled here, the capture root is usable and the transcript is readable.
      const prepared = await prepareCaptureStart({
        workspace,
        provider,
        sessionId,
        dataDir,
        context,
        payload: envelope.payload,
        ancestryFromPid: process.ppid,
        hostChain: hostChainOf(args) as never
      })
      const arrivedAt = new Date().toISOString()
      const queued = await queueCaptureCommand(prepared.enablement, {
        provider,
        sessionId,
        action,
        context: prepared.context,
        payload: envelope.payload,
        event: flag(args, 'event') ?? (action === 'start' ? 'CaptureStart' : 'CaptureStop'),
        arrivedAt,
        ...(flag(args, 'request-id') ? { requestId: flag(args, 'request-id') } : {}),
        ancestryFromPid: process.ppid,
        ...(prepared.hostChain ? { hostChain: prepared.hostChain } : {})
      })
      // The claim is proved on a host event, and that event belongs to the turn the claim opens. It is
      // written by this same process, right behind the claim, because a second invocation would spend
      // the host's remaining budget on another recorder start and the event would be the one dropped.
      const event = flag(args, 'event')
      const eventEntry = event && Object.keys(envelope.payload ?? {}).length > 0
        ? basename(await queueHook(prepared.enablement, {
            provider,
            event,
            workspace: prepared.workspaceRoot,
            payload: envelope.payload,
            captureMode: true,
            deferDelivery: true
          }, sessionId, arrivedAt, { announce: false }))
        : undefined
      // Nothing has been opened yet: the ACK says queued, and only the inbox can prove otherwise.
      await notifyRecorderInbox({ workspace: prepared.workspaceRoot, scriptPath: process.argv[1] })
      process.stdout.write(`${JSON.stringify({
        protocol: SESSION_CAPTURE_PROTOCOL,
        action,
        status: 'queued',
        captureId: prepared.context.captureId,
        sessionId,
        recorderVersion: RECORDER_VERSION,
        // The claim is not applied yet, so the status stays `queued`. The transport is real either
        // way: the caller may write it down now and only rely on it as a fallback.
        transport: prepared.transport,
        ...(prepared.context.diffExclude?.length ? { diffExclude: prepared.context.diffExclude } : {}),
        inbox: {
          entry: basename(queued.path),
          ...(eventEntry ? { eventEntry } : {}),
          directory: queued.inbox,
          failedDirectory: join(dirname(queued.inbox), 'inbox-failed'),
          statePath: captureStatePath(prepared.enablement.dataRoot, provider, sessionId),
          receiverPath: captureReceiverPath(prepared.enablement.dataRoot)
        }
      })}\n`)
      return 0
    }
    if (action === 'start') {
      const result = await startSessionCapture({
        workspace,
        provider,
        sessionId,
        dataDir,
        context,
        payload: envelope.payload,
        ancestryFromPid: process.ppid,
        cli: {
          ...(process.argv[1] ? { entry: process.argv[1] } : {}),
          nodeDir: dirname(process.execPath)
        }
      })
      process.stdout.write(`${JSON.stringify({ ...result.ack, transport: result.transport })}\n`)
      return 0
    }
    const result = await stopSessionCapture({ workspace, provider, sessionId, dataDir, context })
    process.stdout.write(`${JSON.stringify(result.ack)}\n`)
    return 0
  } catch (error) {
    return captureFailure(action === 'stop' ? 'stop' : 'start', context, error)
  }
}
