import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { acquireUploadAdmission } from './admission.js'
import {
  LEGACY_REDACTION_VERSION,
  PROVIDERS,
  UPLOAD_DEADLINE_SECONDS
} from './constants.js'
import {
  pausePending
} from './custody/index.js'
import { hasHeldReceipts } from './custody/receipts.js'
import { UploadError } from './errors.js'
import { LOCK_BUSY_MESSAGE, isLockBusy } from './locks.js'
import { safeSnapshotMaxSequence } from './scry.js'
import {
  assertLegacyLocksMigrated,
  dataRoot,
  prepareUploadRoot,
  uploadRoot
} from './storage.js'
import type { UploadState, UploadSummary } from './types.js'
import { enqueueCommitted, enqueueSnapshot, outboxPaths } from './uploader-custody.js'
import { initializeUploadState, noteTransportFailure, clearTransportFailure, statePath, updateHealth } from './uploader-state.js'
import { uploadPending } from './uploader-worker.js'
import {
  acquireDirectoryLock,
  directoryNames,
  now, readJson,
  sleep,
  writeJsonAtomic
} from './util.js'
export { pruneAckedBodies, releaseDisabled, takeCustody } from './custody/index.js'
export { UploadError } from './errors.js'
export { dataRoot, prepareUploadRoot, uploadRoot } from './storage.js'
export { initializeUploadState, localUploadStatus, readUploadState } from './uploader-state.js'
export { validateReportResponse } from './uploader-worker.js'

const RECORD_ID_RE = /^[a-f0-9]{32,64}$/

async function acquireUploadLock(
  base: string,
  env: NodeJS.ProcessEnv,
  preparationDeadline: number
): Promise<() => Promise<void>> {
  const configured = Number(env.SCRY_UPLOAD_LOCK_WAIT_SECONDS ?? 0)
  const wait = Number.isFinite(configured) ? Math.max(0, Math.min(120, configured)) : 0
  const deadline = Math.min(preparationDeadline, Date.now() + wait * 1_000)
  while (true) {
    try {
      return await acquireDirectoryLock(join(base, 'standalone.lock'))
    } catch (error) {
      if (!isLockBusy(error)) throw error
      if (Date.now() >= deadline)
        throw new UploadError('upload_locked', LOCK_BUSY_MESSAGE, true)
      await sleep(Math.min(100, deadline - Date.now()))
    }
  }
}

function expectedFromEnv(env: NodeJS.ProcessEnv):
  | {
      sequence: number
      recordId: string
      provider?: string
      sessionId?: string
    }
  | undefined {
  if (env.SCRY_UPLOAD_TRIGGER?.trim() !== 'record-commit') return undefined
  const sequence = Number(env.SCRY_UPLOAD_EXPECTED_SEQUENCE)
  const recordId = env.SCRY_UPLOAD_RECORD_ID?.trim() ?? ''
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !RECORD_ID_RE.test(recordId)) {
    throw new UploadError('record_commit_identity_invalid', 'expected record identity invalid', true)
  }
  return { sequence, recordId, provider: env.SCRY_PROVIDER_ID, sessionId: env.SCRY_UPLOAD_SESSION_ID }
}

async function managedTurnPending(workspace: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env.SCRY_RECORDER_MANAGED !== '1' || env.SCRY_UPLOAD_TRIGGER === 'session-start') return false
  const sessionId = env.SCRY_UPLOAD_SESSION_ID?.trim()
  if (!sessionId) return false
  const provider = env.SCRY_PROVIDER_ID?.trim()
  if (provider && !PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
    throw new UploadError('managed_identity_invalid', 'managed provider invalid')
  }
  const runtime = join(dataRoot(workspace), 'runtime')
  const providers = provider ? [provider] : await directoryNames(runtime)
  for (const name of providers) {
    for (const session of await directoryNames(join(runtime, name))) {
      const base = join(runtime, name, session)
      const paths = [join(base, 'open.json')]
      for (const turn of await directoryNames(join(base, 'turns')))
        paths.push(join(base, 'turns', turn, 'pending-open.json'))
      for (const path of paths) {
        const value = await readJson<Record<string, unknown>>(path)
        if (value?.managedByScry === true && value.sessionId === sessionId) return true
      }
    }
  }
  return false
}

async function waitForManagedTurn(
  workspace: string,
  env: NodeJS.ProcessEnv,
  preparationDeadline: number
): Promise<void> {
  const configured = Number(env.SCRY_MANAGED_UPLOAD_WAIT_SECONDS ?? 110)
  const seconds = Math.max(1, Math.min(Number.isFinite(configured) ? configured : 110, 115))
  const deadline = Math.min(preparationDeadline, Date.now() + seconds * 1_000)
  while (await managedTurnPending(workspace, env)) {
    if (Date.now() >= deadline)
      throw new UploadError('managed_turn_pending', 'managed turn is still pending', true)
    await sleep(Math.min(200, deadline - Date.now()))
  }
}

export async function runUpload(
  workspace: string,
  options: {
    expected?: { sequence: number; recordId: string; provider?: string; sessionId?: string }
    env?: NodeJS.ProcessEnv
    mode?: 'flush' | 'wakeup' | 'record-commit'
    legacyUploadDisabled?: boolean
  } = {}
): Promise<UploadSummary> {
  const env = options.env ?? process.env
  const empty = { enqueued: 0, uploaded: 0, duplicated: 0, deadLettered: 0, pending: 0 }
  if (env.SCRY_RECORDER_ENABLED === '0') return empty
  const deadline = Date.now() + uploadDeadline(env) * 1_000
  const preparationDeadline = Math.min(deadline, Date.now() + 40_000)
  const base = await prepareUploadRoot(workspace)
  let release: (() => Promise<void>) | undefined
  let releaseAdmission: (() => Promise<void>) | undefined
  let state: UploadState | null = null
  const timings: Record<string, number> = {}
  let discoveryFailure: UploadError | undefined
  let endpointFailed = false
  let discoverySourceCode: string | undefined
  try {
    await assertLegacyLocksMigrated(base)
    release = await acquireUploadLock(base, env, preparationDeadline)
    state = await initializeUploadState(workspace, 0)
    // A migrated job can deny upload until an explicit enable supersedes it.
    // Check under the upload lock, not before waiting for another invocation.
    const legacyDisabled = options.legacyUploadDisabled && state.enabledEpoch === undefined
    if (env.SCRY_TURN_UPLOAD_ENABLED === '0' || state.uploadEnabled === false || legacyDisabled) {
      if (state.uploadEnabled !== false) state.disabledEpoch = (state.disabledEpoch ?? 0) + 1
      state.uploadEnabled = false
      // Persist the denial before any maintenance which can fail. Discovery
      // is unnecessary while disabled; enable establishes its own high-water.
      await writeJsonAtomic(statePath(workspace), state)
      await pausePending(workspace)
      await updateHealth(
        workspace,
        state,
        { status: 'disabled', currentAttemptId: null, currentAttemptStartedAt: null },
        env
      )
      return { ...empty, pending: (await outboxPaths(workspace)).length }
    }
    state.uploadEnabled = true
    // A background invocation must respect the workspace cooldown recorded by
    // the previous transport failure. Record-level backoff alone would let each
    // fresh wakeup probe the endpoint again with a new batch.
    const background = options.mode === 'wakeup' || options.mode === 'record-commit'
    if (background && (state.transportCooldownUntilMs ?? 0) > Date.now()) {
      const until = Number(state.transportCooldownUntilMs)
      await updateHealth(
        workspace,
        state,
        {
          status: 'deferred',
          deferredUntilMs: until,
          deferredReason: 'workspace_cooldown',
          currentAttemptId: null,
          currentAttemptStartedAt: null
        },
        env
      )
      return { ...empty, pending: (await outboxPaths(workspace)).length, deferredUntilMs: until }
    }
    const attempt = now()
    await updateHealth(
      workspace,
      state,
      {
        status: 'upload_in_progress',
        lastAttemptAt: attempt,
        currentAttemptId: randomUUID(),
        currentAttemptStartedAt: attempt
      },
      env
    )
    const expected = options.expected ?? expectedFromEnv(env)
    // Admission precedes actor/whoami/list-tools, so concurrent workspaces do
    // not amplify expensive authenticated CLI calls.
    // A queued wakeup gives up fast when every slot is busy so worker processes
    // do not pile up behind one long upload; an explicit flush is worth waiting for.
    releaseAdmission = await acquireUploadAdmission(
      env,
      preparationDeadline,
      background ? 1_000 : Number.POSITIVE_INFINITY
    )
    await waitForManagedTurn(workspace, env, preparationDeadline)
    await enqueueCommitted(workspace, state, expected)
    // A slow or broken exporter must not consume the budget needed by bytes
    // already in our custody. Drain those before attempting discovery.
    // A run's own successes are evidence too, but the check needs a stable
    // snapshot of what was acknowledged before this run started.
    const lastSuccessAt = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : undefined
    const lastSuccessAtMs = Number.isFinite(lastSuccessAt) ? lastSuccessAt : undefined
    const uploaded = await uploadPending(workspace, deadline, env, timings, { lastSuccessAtMs })
    endpointFailed = uploaded.endpointFailed === true
    let enqueued = 0
    if (!expected && !uploaded.deferredUntilMs) {
      try {
        enqueued = await enqueueSnapshot(workspace, state, env, Math.min(deadline, Date.now() + 40_000))
      } catch (error) {
        const source = error instanceof UploadError ? error : undefined
        const transport = error as Error & { statusCode?: number; exitCode?: number; signal?: string; stderr?: string }
        discoverySourceCode = source?.code
        if (source?.code === 'upload_deadline_exhausted' || Date.now() >= deadline) {
          uploaded.deferredUntilMs = Date.now() + 100
        } else {
          discoveryFailure = new UploadError(
            'discovery_blocked',
            source ? `Scry export blocked (${source.code})` : 'Scry export was not completed',
            true,
            undefined,
            { cause: error }
          )
          discoveryFailure.stage = 'export'
          discoveryFailure.deferJobAttempt = true
          discoveryFailure.statusCode = source?.statusCode ?? transport.statusCode
          discoveryFailure.exitCode = source?.exitCode ?? transport.exitCode
          discoveryFailure.signal = source?.signal ?? transport.signal
          discoveryFailure.stderr = (source?.stderr ?? transport.stderr)?.slice(0, 512)
        }
      }
      if (!uploaded.deferredUntilMs) {
        const discovered = await uploadPending(workspace, deadline, env, timings, { lastSuccessAtMs })
        uploaded.uploaded += discovered.uploaded
        uploaded.duplicated += discovered.duplicated
        uploaded.deadLettered += discovered.deadLettered
        uploaded.deferredUntilMs = discovered.deferredUntilMs
        endpointFailed = endpointFailed || discovered.endpointFailed === true
      }
    }
    // Only endpoint failures widen the workspace cooldown. Budget deferrals and
    // ordinary record backoff are not endpoint health signals, and counting them
    // would block every later wakeup for no reason. Clearing it requires a real
    // acknowledgement: a run that sent nothing proves nothing about the endpoint.
    const acknowledged = uploaded.uploaded + uploaded.duplicated > 0
    if (endpointFailed || discoveryFailure) {
      const until = noteTransportFailure(state)
      if (uploaded.deferredUntilMs !== undefined) uploaded.deferredUntilMs = Math.max(uploaded.deferredUntilMs, until)
    } else if (acknowledged) clearTransportFailure(state)
    await writeJsonAtomic(statePath(workspace), state)
    await updateHealth(workspace, state, { lastUploadedCount: uploaded.uploaded }, env)
    const pending = (await outboxPaths(workspace)).length
    if (discoveryFailure) {
      await updateHealth(
        workspace,
        state,
        {
          status: 'discovery_blocked',
          discoveryErrorCode: discoverySourceCode ?? discoveryFailure.code,
          lastUploadedCount: uploaded.uploaded
        },
        env
      )
      throw discoveryFailure
    }
    // "Last success" means a real acknowledgement. A run that only deferred
    // proves nothing about the endpoint, and the retry classifier relies on this
    // being the last time the server accepted a record.
    if (acknowledged) state.lastSuccessAt = now()
    delete state.lastError
    await writeJsonAtomic(statePath(workspace), state)
    await updateHealth(
      workspace,
      state,
      {
        status: uploaded.deferredUntilMs
          ? 'deferred'
          : await hasHeldReceipts(uploadRoot(workspace))
            ? 'held_disabled'
            : 'healthy',
        deferredUntilMs: uploaded.deferredUntilMs ?? null,
        currentAttemptId: null,
        currentAttemptStartedAt: null,
        lastSuccessAt: state.lastSuccessAt,
        lastUploadedCount: uploaded.uploaded,
        lastErrorCode: null,
        lastErrorAt: null,
        lastTransportStage: null,
        lastTransportDurationMs: null,
        lastTransportErrorType: null,
        lastTransportStatus: null,
        lastTransportSignal: null,
        transportTimingsMs: timings
      },
      env
    )
    return { enqueued, ...uploaded, pending }
  } catch (error) {
    const failure =
      error instanceof UploadError
        ? error
        : new UploadError('upload_failed', error instanceof Error ? error.name : 'unknown', true, undefined, {
            cause: error
          })
    if (failure.deferred && failure.retryAtMs !== undefined) {
      await updateHealth(workspace, state, {
        status: 'deferred',
        deferredUntilMs: failure.retryAtMs,
        deferredReason: failure.code,
        currentAttemptId: null,
        currentAttemptStartedAt: null,
        lastErrorCode: null,
        lastErrorAt: null
      }, env)
      return {
        ...empty,
        pending: (await outboxPaths(workspace)).length,
        deferredUntilMs: failure.retryAtMs,
        deferredReason: failure.code
      }
    }
    const failedAt = now()
    if (
      failure.retryable &&
      !['invalid_installation_id', 'record_commit_identity_invalid'].includes(failure.code)
    )
      failure.deferJobAttempt = true
    if (state) {
      // Protocol and transport failures also widen the workspace cooldown; this
      // covers failures raised outside a transport stage, such as an invalid
      // response envelope. Progress deferrals and lock contention are not
      // endpoint failures and must not delay the next attempt.
      if (failure.stage !== undefined || failure.code.startsWith('transport_') || failure.code === 'invalid_mcp_response')
        noteTransportFailure(state)
      state.lastError = { at: failedAt, code: failure.code, message: failure.message.slice(0, 500) }
      await writeJsonAtomic(statePath(workspace), state)
    }
    await updateHealth(
      workspace,
      state,
      {
        status: failure.code === 'discovery_blocked' ? 'discovery_blocked' : 'error',
        currentAttemptId: null,
        currentAttemptStartedAt: null,
        lastErrorCode: failure.code,
        lastErrorAt: failedAt,
        lastTransportStage: failure.stage ?? null,
        lastTransportDurationMs: failure.durationMs ?? null,
        lastTransportErrorType: failure.errorType ?? null,
        lastTransportStatus: failure.statusCode ?? null,
        lastTransportSignal: failure.signal ?? null,
        transportTimingsMs: timings,
        lastFailureCode: failure.code,
        lastFailureAt: failedAt,
        lastFailureTransportStage: failure.stage ?? null,
        lastFailureTransportDurationMs: failure.durationMs ?? null,
        lastFailureTransportErrorType: failure.errorType ?? null,
        lastFailureTransportTimingsMs: timings
      },
      env
    )
    throw failure
  } finally {
    if (releaseAdmission) await releaseAdmission()
    if (release) await release()
  }
}
function uploadDeadline(env: NodeJS.ProcessEnv): number {
  const value = Number(env.SCRY_UPLOAD_DEADLINE_SECONDS || UPLOAD_DEADLINE_SECONDS)
  return Math.max(30, Math.min(Number.isFinite(value) ? value : UPLOAD_DEADLINE_SECONDS, 280))
}
export async function setUploadPolicy(
  workspace: string,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env
): Promise<UploadState> {
  const base = await prepareUploadRoot(workspace)
  await assertLegacyLocksMigrated(base)
  const release = await acquireUploadLock(base, env, Date.now() + 40_000)
  let state: UploadState
  try {
    state = await initializeUploadState(workspace, 0)
    if (enabled && state.uploadEnabled === undefined) {
      // No policy was ever recorded, and uploads are already allowed by default.
      // Enabling is not a transition here: pausing and moving the high-water
      // would hold records that were never disabled and force a manual release.
      state.uploadEnabled = true
      state.enabledEpoch = state.enabledEpoch ?? 1
      await writeJsonAtomic(statePath(workspace), state)
      await updateHealth(workspace, state, {
        status: 'ready',
        currentAttemptId: null,
        currentAttemptStartedAt: null
      }, { ...env, SCRY_TURN_UPLOAD_ENABLED: '1' })
    } else if (state.uploadEnabled === enabled) {
      if (enabled && state.enabledEpoch === undefined) {
        state.enabledEpoch = 1
        await writeJsonAtomic(statePath(workspace), state)
      }
      return state
    } else {
      state.uploadEnabled = false
      if (!enabled) state.disabledEpoch = (state.disabledEpoch ?? 0) + 1
      await writeJsonAtomic(statePath(workspace), state)
      await pausePending(workspace)
      if (enabled) {
        // Never activate until the canonical high-water excludes the complete
        // disabled interval, including records whose hooks never ran.
        const baseline = await safeSnapshotMaxSequence(workspace, env)
        state.disabledThrough = Math.max(state.disabledThrough ?? 0, baseline)
        state.enqueuedThrough = Math.max(state.enqueuedThrough, baseline)
        state.uploadEnabled = true
        state.enabledEpoch = (state.enabledEpoch ?? 0) + 1
        await writeJsonAtomic(statePath(workspace), state)
      }
      await updateHealth(workspace, state, {
        status: enabled ? 'ready' : 'disabled',
        currentAttemptId: null,
        currentAttemptStartedAt: null
      }, { ...env, SCRY_TURN_UPLOAD_ENABLED: enabled ? '1' : '0' })
    }
  } finally {
    await release()
  }
  if (enabled) {
    const { enqueueWakeup } = await import('./queue.js')
    await enqueueWakeup(workspace, { ...env, SCRY_TURN_UPLOAD_ENABLED: '1' })
  }
  return state
}

export async function migrateLegacy(workspace: string): Promise<{ pending: number }> {
  await prepareUploadRoot(workspace)
  // Legacy redacted envelopes stay byte-for-byte unchanged. This command only creates
  // a durable migration marker; it never treats the old cursor as ACK or starts an upload.
  await writeJsonAtomic(join(uploadRoot(workspace), 'migration.json'), {
    version: 1,
    migratedAt: now(),
    legacyRedactionVersion: LEGACY_REDACTION_VERSION,
    legacyLocksConfirmed: true
  })
  return { pending: (await outboxPaths(workspace)).length }
}
