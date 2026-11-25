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
      ancestryFromPid: process.ppid
    })
    if (queueOnly) {
      await notifyRecorderInbox({ workspace: workspaceOf(args), scriptPath: process.argv[1] })
    } else {
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

function hostChainOf(args: ParsedArgs): unknown {
  const raw = flag(args, 'host-chain')
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new CaptureRequestError('invalid_request', '--host-chain must be a JSON array')
  }
}

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
      await notifyRecorderInbox({ workspace: prepared.workspaceRoot, scriptPath: process.argv[1] })
      process.stdout.write(`${JSON.stringify({
        protocol: SESSION_CAPTURE_PROTOCOL,
        action,
        status: 'queued',
        captureId: prepared.context.captureId,
        sessionId,
        recorderVersion: RECORDER_VERSION,
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
