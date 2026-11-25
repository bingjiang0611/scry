import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { markSessionAttention, withSessionAttentionLock } from './attention.js'
import type { RecorderEnablement } from './config.js'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog, writeJsonAtomic } from './io.js'
import type { HostProcess } from './host-process.js'
import type { QueuedCaptureCommand, QueuedHook, RecorderHookInput } from './recorder-contracts.js'
import { recorderSessionRoot } from './runtime-state.js'
import { safeKey, stableHash } from './store.js'
import type { SessionCaptureContext } from './session-capture-contract.js'
import { captureWireContext } from './session-capture-contract.js'
export function validQueuedCapture(queued: QueuedHook, provider: ProviderId): boolean {
  const capture = queued.capture
  if (capture === undefined) return true
  return typeof capture === 'object' && capture !== null &&
    typeof capture.captureId === 'string' && capture.host === provider &&
    capture.sessionId === queued.sessionId
}

async function inboxEntryName(root: string, arrivedAt: string): Promise<string> {
  const millis = String(Date.parse(arrivedAt)).padStart(15, '0')
  const sequence = await nextInboxSequence(root)
  return `${millis}-${String(sequence).padStart(9, '0')}-${randomUUID()}.json`
}

async function nextInboxSequence(root: string): Promise<number> {
  const path = join(root, 'inbox-sequence')
  let previous = 0
  try {
    const parsed = Number((await readFile(path, 'utf8')).trim())
    if (Number.isSafeInteger(parsed) && parsed > 0) previous = parsed
  } catch {
  }
  const next = previous + 1
  await writeJsonAtomic(path, next, { sync: false }).catch(() => undefined)
  return next
}

export async function queueHook(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string,
  arrivedAt: string,
  options: { reason?: string; announce?: boolean } = {}
): Promise<string> {
  const entry: QueuedHook = {
    schemaVersion: 1,
    provider: input.provider,
    sessionId,
    event: input.event,
    payload: input.payload,
    uploadEnvironment: input.uploadEnvironment,
    ...(input.managed ? { managed: true } : {}),
    ...(input.capture ? { capture: input.capture } : {}),
    ...(input.captureMode ? { captureMode: true } : {}),
    arrivedAt
  }
  const root = recorderSessionRoot(enablement.dataRoot, input.provider, sessionId)
  const sessionKey = safeKey(sessionId)
  const path = await withSessionAttentionLock(enablement.dataRoot, input.provider, sessionKey, async () => {
    await markSessionAttention(enablement.dataRoot, input.provider, sessionKey)
    const target = join(root, 'inbox', await inboxEntryName(root, arrivedAt))
    await writeJsonAtomic(target, entry)
    return target
  })
  if (options.announce !== false) {
    await appendRotatingLog(
      join(enablement.dataRoot, 'logs', 'recorder.log'),
      `${new Date().toISOString()} WARN ${options.reason ?? (input.queueOnly ? 'daemon delivery uncertain' : 'session lock busy')}; queued ${input.provider} ${input.event} for replay (arrived ${arrivedAt})`
    ).catch(() => undefined)
  }
  return path
}

function validHostChain(value: unknown): HostProcess[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined
  const chain: HostProcess[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const { pid, token } = item as { pid?: unknown; token?: unknown }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return undefined
    if (token !== undefined && (typeof token !== 'string' || token.length > 128 || /[\r\n]/.test(token))) return undefined
    chain.push({ pid, ...(typeof token === 'string' ? { token } : {}) })
  }
  return chain
}

export async function queueCaptureCommand(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  args: {
    provider: ProviderId
    sessionId: string
    action: 'start' | 'stop'
    context: SessionCaptureContext
    payload: Record<string, unknown>
    event: string
    arrivedAt: string
    requestId?: string
    ancestryFromPid?: number
    hostChain?: HostProcess[]
  }
): Promise<{ path: string; inbox: string }> {
  const root = recorderSessionRoot(enablement.dataRoot, args.provider, args.sessionId)
  const sessionKey = safeKey(args.sessionId)
  const hostChain = validHostChain(args.hostChain)
  const entry: QueuedCaptureCommand = {
    schemaVersion: 1,
    kind: 'capture',
    provider: args.provider,
    sessionId: args.sessionId,
    action: args.action,
    context: captureWireContext(args.context),
    payload: args.payload,
    event: args.event,
    arrivedAt: args.arrivedAt,
    ...(args.requestId ? { requestId: args.requestId } : {}),
    ...(args.ancestryFromPid && args.ancestryFromPid > 1 ? { ancestryFromPid: args.ancestryFromPid } : {}),
    ...(hostChain ? { hostChain } : {})
  }
  const path = await withSessionAttentionLock(enablement.dataRoot, args.provider, sessionKey, async () => {
    await markSessionAttention(enablement.dataRoot, args.provider, sessionKey)
    const target = join(root, 'inbox', await inboxEntryName(root, args.arrivedAt))
    await writeJsonAtomic(target, entry)
    return target
  })
  await appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} INFO queued capture ${args.action} for ${args.provider}/${stableHash(args.sessionId).slice(0, 12)} (arrived ${args.arrivedAt})`
  ).catch(() => undefined)
  return { path, inbox: join(root, 'inbox') }
}
