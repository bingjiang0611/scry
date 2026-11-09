import type { RunControlHandlers } from './host-run-control'
import { DAEMON_LOCAL_OP_CHANNELS, DAEMON_LOCAL_OP_NAMES } from '../daemon-channel-gate'

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

export async function handleLocalOp(handlers: LocalOpHandlers | undefined, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!handlers) return { error: 'unsupported_op' }
  if (Object.keys(request).some((key) => !['op', 'keepAlive', 'protocol', 'method', 'args'].includes(key))) return { error: 'invalid_request' }
  const args = request.args ?? []
  if (typeof request.method !== 'string' || !Array.isArray(args) || args.length > MAX_ARGS) return { error: 'invalid_request' }
  const handler = handlers.get(`${request.op as string}:${request.method}`)
  if (!handler) return { error: 'unsupported_op' }
  // JSON has no undefined; a handler that returns nothing answers null.
  return { result: (await handler(...args)) ?? null }
}
