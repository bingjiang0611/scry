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
/**
 * A replayed capture context must still be the same capture for this Provider and session; anything
 * else would make the replay look like a different recording of the same work.
 */
export function validQueuedCapture(queued: QueuedHook, provider: ProviderId): boolean {
  const capture = queued.capture
  if (capture === undefined) return true
  return typeof capture === 'object' && capture !== null &&
    typeof capture.captureId === 'string' && capture.host === provider &&
    capture.sessionId === queued.sessionId
}

/**
 * Arrival-ordered inbox name.
 *
 * Names are the replay order, so a claim always replays before the event that proved it. Millisecond
 * resolution alone cannot order two entries written in the same tick (a claim and its own event are
 * exactly that case), hence the durable per-session counter: it only breaks ties, it never reorders
 * entries from different milliseconds. The UUID keeps the name unique and the ordering independent of
 * a counter that a crash could reset.
 */
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
    // Absent or unreadable: a fresh counter still names this entry, and the UUID keeps it unique.
  }
  const next = previous + 1
  // Not synced: this is an ordering hint, not evidence. A lost increment can only tie two entries,
  // which the name's UUID and at-least-once replay already tolerate.
  await writeJsonAtomic(path, next, { sync: false }).catch(() => undefined)
  return next
}

/**
 * Persist a hook event durably before it can be dropped.
 *
 * Returns the inbox entry path so a caller that applies the event inline can remove that exact
 * copy afterwards; leaving it would replay the same event as a later duplicate.
 */
export async function queueHook(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string,
  arrivedAt: string,
  /**
   * `reason` explains the queue in the operator log; `announce: false` keeps a queue drain silent,
   * for a copy that the caller applies and removes inline in the same critical section.
   */
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
  // This must not take the session lock: a busy session is precisely why this hook is queued.
  // Hold the attention lock from index-first publication until the inbox entry is durable.
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

/** Discard anything that cannot be host evidence; a claim is never allowed to invent a process. */
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

/**
 * Persist one session-capture claim for the recorder daemon.
 *
 * The entry, not a hook process, is what carries the claim: it holds the validated context, the
 * Provider event the claim was proved on and the host chain that must outlive the turn. Returns the
 * entry path and the inbox it was written into, so the caller can answer for that exact request.
 */
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
    // The wire document, like every other place this context is persisted: the drain validates it
    // with the same parser the CLI uses for stdin.
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
