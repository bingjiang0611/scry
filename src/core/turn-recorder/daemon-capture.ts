import type { ServerResponse } from 'node:http'
import type { ProviderId } from '../../shared/provider.js'
import type { RecorderEnablement } from './config.js'
import { applySessionCaptureHook } from './session-capture.js'
import { CaptureRequestError } from './session-capture-contract.js'
import { writeJson } from './daemon-transport.js'
import { drainRecorderDelivery } from './recorder.js'

export async function serveCaptureRequest(args: {
  enablement: Extract<RecorderEnablement, { enabled: true }>
  provider: ProviderId
  event: string
  payload: Record<string, unknown>
  env: NodeJS.ProcessEnv
  response: ServerResponse
  recovery: () => void
  deliveries: Set<Promise<unknown>>
  ancestryFromPid?: number
}): Promise<void> {
  let ack: Record<string, unknown>
  try {
    ack = (await applySessionCaptureHook({
      workspace: args.enablement.workspaceRoot,
      provider: args.provider,
      event: args.event,
      dataDir: args.enablement.dataRoot,
      payload: args.payload,
      env: args.env,
      deferDelivery: true,
      ...(args.ancestryFromPid ? { ancestryFromPid: args.ancestryFromPid } : {})
    })).ack
  } catch (error) {
    if (error instanceof CaptureRequestError) throw Object.assign(error, { statusCode: 400 })
    throw error
  }
  args.recovery()
  writeJson(args.response, 200, ack)
  const delivery = drainRecorderDelivery(args.enablement.workspaceRoot, args.env).catch(() => undefined)
  args.deliveries.add(delivery)
  void delivery.finally(() => { args.deliveries.delete(delivery) })
}
