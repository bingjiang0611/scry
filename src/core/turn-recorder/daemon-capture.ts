import type { ServerResponse } from 'node:http'
import type { ProviderId } from '../../shared/provider.js'
import type { RecorderEnablement } from './config.js'
import { applySessionCaptureHook } from './session-capture.js'
import { CaptureRequestError } from './session-capture-contract.js'
import { writeJson } from './daemon-transport.js'
import { drainRecorderDelivery } from './recorder.js'

/**
 * The daemon side of session capture. The guard posts the same `{capture, payload}` document the CLI
 * reads, so the fast path and the fallback cannot disagree about what was delivered. The daemon
 * answers with the capture ACK and drains delivery after the response, outside the Provider's hook
 * budget.
 */
export async function serveCaptureRequest(args: {
  enablement: Extract<RecorderEnablement, { enabled: true }>
  provider: ProviderId
  event: string
  payload: Record<string, unknown>
  env: NodeJS.ProcessEnv
  response: ServerResponse
  recovery: () => void
  deliveries: Set<Promise<unknown>>
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
      deferDelivery: true
    })).ack
  } catch (error) {
    // A refusal before apply stays a 4xx so the guard's fallback may still deliver the event.
    if (error instanceof CaptureRequestError) throw Object.assign(error, { statusCode: 400 })
    throw error
  }
  args.recovery()
  writeJson(args.response, 200, ack)
  const delivery = drainRecorderDelivery(args.enablement.workspaceRoot, args.env).catch(() => undefined)
  args.deliveries.add(delivery)
  void delivery.finally(() => { args.deliveries.delete(delivery) })
}
