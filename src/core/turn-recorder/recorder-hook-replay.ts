import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import type { RecorderEnablement } from './config.js'
import { appendRotatingLog, readJson } from './io.js'
import { recorderInboxEntries, INBOX_MAX_ATTEMPTS, quarantineInboxEntry, readInboxFailure, readInboxJson } from './inbox.js'
import { validQueuedCapture } from './recorder-hook-queue.js'
import type { QueuedCaptureCommand, QueuedHook } from './recorder-contracts.js'
import { captureStateContext, parseSessionCaptureContext, readCaptureState, START_EVENT_NAMES } from './session-capture-contract.js'
import { recordCaptureRepositories } from './session-capture-discovery.js'
import { BACKGROUND_WAKE_PROVIDERS, CODEX_SUBAGENT_MARKER, START_EVENTS, hookArrival, providerTurnIdOf } from './recorder-contracts.js'
import { recorderOpenPath as openPath, type RecorderOpenTurnState as OpenTurnState } from './runtime-state.js'
import { applyHookLocked } from './recorder-hook-locked.js'
import { codexSubagentTranscript, isSynthetic, isCodexInternalPrompt, markCodexInternalTurn, trustedManagedIdentityPayload, isTaskNotificationPrompt } from './recorder-hook-support.js'
import { recordError, safeKey } from './store.js'

async function applyQueuedCapture(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  entry: QueuedCaptureCommand
): Promise<void> {
  const context = parseSessionCaptureContext(entry.context, entry.provider)
  if (context.sessionId !== entry.sessionId) {
    throw new Error(`queued capture claim names another session: ${context.sessionId}`)
  }
  const { startSessionCapture, stopSessionCapture } = await import('./session-capture.js')
  const cli = process.argv[1]
    ? { entry: process.argv[1], nodeDir: dirname(process.execPath) }
    : {}
  if (entry.action === 'start') {
    await startSessionCapture({
      workspace: enablement.workspaceRoot,
      provider: entry.provider,
      sessionId: entry.sessionId,
      dataDir: enablement.dataRoot,
      context,
      payload: entry.payload,
      cli,
      sessionLockHeld: true,
      ...(entry.ancestryFromPid ? { ancestryFromPid: entry.ancestryFromPid } : {}),
      ...(entry.hostChain ? { hostChain: entry.hostChain } : {})
    })
    return
  }
  await stopSessionCapture({
    workspace: enablement.workspaceRoot,
    provider: entry.provider,
    sessionId: entry.sessionId,
    dataDir: enablement.dataRoot,
    context,
    sessionLockHeld: true
  })
}

export async function replayQueuedHooks(
  enablement: Extract<RecorderEnablement, { enabled: true }>,
  provider: ProviderId,
  sessionKey: string,
  includeFailed = false,
  expectedSessionId?: string,
  qoderStopRecoveryScheduled?: boolean
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
  for (const entry of await recorderInboxEntries(root, includeFailed)) {
    let attempts: number
    try {
      attempts = (await readInboxFailure(entry))?.attempts ?? 0
    } catch (error) {
      await warn(entry.name, error)
      continue
    }
    if (attempts >= INBOX_MAX_ATTEMPTS) continue
    try {
      const queued = await readInboxJson<QueuedHook | QueuedCaptureCommand>(entry.path)
      if (queued === null) continue
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
      if (queued.kind === 'capture') {
        if (queued.action !== 'start' && queued.action !== 'stop') {
          throw new Error(`invalid queued capture action: ${entry.name}`)
        }
        await hookArrival.run(queued.arrivedAt, () => applyQueuedCapture(enablement, queued))
      } else {
        if (!validQueuedCapture(queued, provider)) {
          throw new Error(`invalid queued recorder hook: ${entry.name}`)
        }
        const state = queued.captureMode && !queued.capture
          ? await readCaptureState(enablement.dataRoot, provider, queued.sessionId)
          : null
        const capture = queued.capture ?? (state ? captureStateContext(state) : undefined)
        if (queued.captureMode && !capture) {
          throw new Error(`queued capture event has no open capture: ${entry.name}`)
        }
        if (state?.stopRequestedAt && START_EVENT_NAMES.has(queued.event)) {
        } else {
          let payload = queued.managed
            ? queued.payload
            : trustedManagedIdentityPayload(queued.payload, false, {})
          const taskNotification = START_EVENTS.has(queued.event) &&
            (provider === 'claude' || BACKGROUND_WAKE_PROVIDERS.has(provider)) &&
            isTaskNotificationPrompt(payload)
          if (isSynthetic(payload) && !taskNotification) {
          } else if (provider === 'codex' && START_EVENTS.has(queued.event) && isCodexInternalPrompt(payload)) {
            const turnId = providerTurnIdOf(payload, provider)
            if (turnId) {
              await hookArrival.run(queued.arrivedAt, () =>
                markCodexInternalTurn(enablement.dataRoot, provider, queued.sessionId, turnId))
            }
          } else {
            if (provider === 'codex' && await codexSubagentTranscript(payload, queued.sessionId)) {
              payload = { ...payload, [CODEX_SUBAGENT_MARKER]: true }
            }
            await hookArrival.run(queued.arrivedAt, async () => {
              await applyHookLocked(enablement, {
                provider,
                event: queued.event,
                workspace: enablement.workspaceRoot,
                payload,
                managed: queued.managed,
                qoderStopRecoveryScheduled,
                uploadEnvironment: queued.uploadEnvironment,
                ...(capture ? { capture } : {})
              }, queued.sessionId)
              if (queued.captureMode && queued.event === 'PreToolUse' && capture) {
                await recordCaptureRepositories(enablement, provider, queued.sessionId, payload)
              }
            })
          }
        }
      }
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
        await warn(entry.name, isolationError)
      }
      await warn(entry.name, error)
      continue
    }
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
