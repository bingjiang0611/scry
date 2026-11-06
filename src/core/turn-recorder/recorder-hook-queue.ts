import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { markSessionAttention, withSessionAttentionLock } from './attention.js'
import type { RecorderEnablement } from './config.js'
import { appendRotatingLog, writeJsonAtomic } from './io.js'
import type { RecorderHookInput, QueuedHook } from './recorder-contracts.js'
import { recorderSessionRoot } from './runtime-state.js'
import { safeKey } from './store.js'

export async function queueHook(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  input: RecorderHookInput,
  sessionId: string,
  arrivedAt: string
): Promise<void> {
  const entry: QueuedHook = {
    schemaVersion: 1,
    provider: input.provider,
    sessionId,
    event: input.event,
    payload: input.payload,
    uploadEnvironment: input.uploadEnvironment,
    ...(input.managed ? { managed: true } : {}),
    arrivedAt
  }
  // Names sort by arrival; the UUID only separates hooks that arrive in the same millisecond.
  const name = `${String(Date.parse(arrivedAt)).padStart(15, '0')}-${randomUUID()}.json`
  const root = recorderSessionRoot(enablement.dataRoot, input.provider, sessionId)
  const sessionKey = safeKey(sessionId)
  // This must not take the session lock: a busy session is precisely why this hook is queued.
  // Hold the attention lock from index-first publication until the inbox entry is durable.
  await withSessionAttentionLock(enablement.dataRoot, input.provider, sessionKey, async () => {
    await markSessionAttention(enablement.dataRoot, input.provider, sessionKey)
    await writeJsonAtomic(join(root, 'inbox', name), entry)
  })
  await appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} WARN ${input.queueOnly ? 'daemon delivery uncertain' : 'session lock busy'}; queued ${input.provider} ${input.event} for replay (arrived ${arrivedAt})`
  ).catch(() => undefined)
}
