import { dirname } from 'node:path'
import { type ParsedArgs, workspaceOf, readStdin, flag, providerOf } from './command-args.js'
import { startRecorderDaemon } from '../core/turn-recorder/daemon.js'
import {
  CaptureRequestError,
  SESSION_CAPTURE_PROTOCOL,
  captureExitCode,
  parseCaptureEnvelope,
  parseHookPayload,
  parseSessionCaptureContext,
  type SessionCaptureContext
} from '../core/turn-recorder/session-capture-contract.js'
import { applySessionCaptureHook, startSessionCapture, stopSessionCapture } from '../core/turn-recorder/session-capture.js'

/**
 * Session-capture delivery. `--capture-mode` must be explicit: silently accepting the flag and then
 * applying an ordinary hook would make an opt-in workspace record sessions nobody opened.
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
    const result = await applySessionCaptureHook({
      workspace: workspaceOf(args),
      provider,
      event,
      dataDir,
      ...(flag(args, 'session-id') ? { sessionId: flag(args, 'session-id') } : {}),
      payload,
      queueOnly: process.env.SCRY_RECORDER_DAEMON_TRIED === '1'
    })
    // The receiver only falls back when the daemon did not apply this event: no daemon, or one from
    // another recorder version that refused the handshake. Start ours so the rest of the session
    // uses the fast path; an unknown delivery is never a reason to replace a live peer.
    const daemonEnabled = process.env.SCRY_RECORDER_TRANSPORT !== 'direct'
    if (daemonEnabled && process.env.SCRY_RECORDER_DAEMON_TRIED !== '1'
      && result.status !== 'ignored' && process.argv[1]) {
      await startRecorderDaemon({ workspace: workspaceOf(args), scriptPath: process.argv[1], waitForReady: false }).catch(() => undefined)
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

/** CodeLens opens and closes a session here; the recorder owns the turn boundary it implies. */
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
    if (action === 'start') {
      const result = await startSessionCapture({
        workspace,
        provider,
        sessionId,
        dataDir,
        context,
        payload: envelope.payload,
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
