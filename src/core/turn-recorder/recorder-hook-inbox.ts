// Replaying the session inbox: hooks queued while the session lock was busy, applied later in
// arrival order through applyHookLocked.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { appendRotatingLog, readJson } from './io.js'
import { recordError, safeKey } from './store.js'
import { recorderInboxEntries, INBOX_MAX_ATTEMPTS, quarantineInboxEntry, readInboxFailure, readInboxJson } from './inbox.js'
import { recorderOpenPath as openPath, type RecorderOpenTurnState as OpenTurnState } from './runtime-state.js'
import type { RecorderEnablement } from './config.js'
import { hookArrival, type QueuedHook } from './recorder-contracts.js'
import { applyHookLocked } from './recorder-hook-locked.js'

/**
 * Apply queued hooks in arrival order. Caller must hold the session lock. Delivery is
 * at-least-once: a crash between apply and unlink replays the hook, which the lifecycle
 * event ids, start fingerprints and committed-turn checks already absorb.
 */
export async function replayQueuedHooks(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionKey: string,
  includeFailed = false,
  expectedSessionId?: string
): Promise<number> {
  const root = join(enablement.dataRoot, 'runtime', provider, sessionKey)
  if (expectedSessionId !== undefined) {
    const open = await readJson<OpenTurnState>(openPath(root))
    if (open && (open.provider !== provider || open.sessionId !== expectedSessionId)) {
      throw new Error(`scoped recorder recovery open identity differs from requested ${provider}/${expectedSessionId}`)
    }
  }
  const warn = (name: string, error: unknown) => appendRotatingLog(
    join(enablement.dataRoot, 'logs', 'recorder.log'),
    `${new Date().toISOString()} WARN inbox ${provider}/${sessionKey}/${name}: ${error instanceof Error ? error.message : String(error)}`
  ).catch(() => undefined)
  let replayed = 0
  // Each pass is arrival-ordered. An isolated older failure cannot block later arrivals; a retry
  // can therefore execute after them. Lifecycle deduplication, not exactly-once delivery, applies.
  for (const entry of await recorderInboxEntries(root, includeFailed)) {
    let attempts: number
    try {
      attempts = (await readInboxFailure(entry))?.attempts ?? 0
    } catch (error) {
      // Do not overwrite an unreadable attempt counter or block the remaining files.
      await warn(entry.name, error)
      continue
    }
    if (attempts >= INBOX_MAX_ATTEMPTS) continue
    try {
      const queued = await readInboxJson<QueuedHook>(entry.path)
      if (queued === null) continue // ENOENT only: another completed cleanup, not a lost event.
      if (queued.schemaVersion !== 1 || queued.provider !== provider ||
        typeof queued.sessionId !== 'string' || safeKey(queued.sessionId) !== sessionKey ||
        (expectedSessionId !== undefined && queued.sessionId !== expectedSessionId) ||
        typeof queued.event !== 'string' || !queued.payload || typeof queued.payload !== 'object' ||
        Array.isArray(queued.payload) || typeof queued.arrivedAt !== 'string' ||
        !Number.isFinite(Date.parse(queued.arrivedAt))) {
        if (expectedSessionId !== undefined && (queued.provider !== provider || queued.sessionId !== expectedSessionId)) {
          throw new Error(`scoped recorder inbox identity differs from requested session: ${entry.name}`)
        }
        throw new Error(`invalid queued recorder hook: ${entry.name}`)
      }
      await hookArrival.run(queued.arrivedAt, () => applyHookLocked(enablement, {
        provider,
        event: queued.event,
        workspace: enablement.workspaceRoot,
        payload: queued.payload,
        managed: queued.managed,
        uploadEnvironment: queued.uploadEnvironment
      }, queued.sessionId))
    } catch (error) {
      if (expectedSessionId !== undefined && error instanceof Error && error.message.startsWith('scoped recorder inbox identity')) {
        throw error
      }
      try {
        await quarantineInboxEntry(entry, attempts + 1, error)
        if (attempts + 1 === INBOX_MAX_ATTEMPTS) {
          await recordError(enablement.dataRoot, `inbox retries exhausted ${provider}/${sessionKey}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      } catch (isolationError) {
        // The source remains in place if it cannot be moved; never delete it to make progress.
        await warn(entry.name, isolationError)
      }
      await warn(entry.name, error)
      continue
    }
    // Cleanup failure is not another failed apply. Keeping the event gives at-least-once replay.
    try {
      await rm(entry.path, { force: true })
      await rm(entry.failurePath, { force: true })
      replayed++
    } catch (error) {
      await warn(entry.name, error)
    }
  }
  return replayed
}
