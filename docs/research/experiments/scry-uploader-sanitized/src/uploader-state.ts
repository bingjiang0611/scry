import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_REDACTION_VERSION, REDACTION_VERSION } from './constants.js'
import { readReceipt } from './custody/index.js'
import { UploadError } from './errors.js'
import { uploadRoot } from './storage.js'
import type { OutboxEnvelope, UploadState } from './types.js'
import { outboxPaths } from './uploader-custody.js'
import { directoryNames, ensurePrivateDirectory, now, readJson, writeJsonAtomic } from './util.js'

export function statePath(workspace: string): string {
  return join(uploadRoot(workspace), 'state.json')
}

export async function readUploadState(workspace: string): Promise<UploadState | null> {
  return await readJson<UploadState>(statePath(workspace))
}
export async function initializeUploadState(workspace: string, baseline: number): Promise<UploadState> {
  const existing = await readUploadState(workspace)
  if (existing) {
    if (
      existing.version !== 1 ||
      !Number.isSafeInteger(existing.enqueuedThrough) ||
      existing.enqueuedThrough < 0
    ) {
      throw new UploadError('invalid_upload_state', 'upload cursor is invalid')
    }
    if (
      existing.redactionVersion !== undefined &&
      ![REDACTION_VERSION, LEGACY_REDACTION_VERSION].includes(existing.redactionVersion)
    ) {
      throw new UploadError('redaction_version_mismatch', 'unsupported upload state version')
    }
    for (const value of [existing.disabledThrough, existing.disabledEpoch, existing.enabledEpoch]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new UploadError('invalid_upload_state', 'upload epoch is invalid')
    }
    if (existing.uploadEnabled !== undefined && typeof existing.uploadEnabled !== 'boolean')
      throw new UploadError('invalid_upload_state', 'upload policy is invalid')
    existing.redactionVersion = REDACTION_VERSION
    return existing
  }
  const state: UploadState = {
    version: 1,
    enqueuedThrough: baseline,
    initializedAt: now(),
    redactionVersion: REDACTION_VERSION
  }
  await ensurePrivateDirectory(uploadRoot(workspace), false)
  await writeJsonAtomic(statePath(workspace), state)
  return state
}

export async function updateHealth(
  workspace: string,
  state: UploadState | null,
  changes: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const base = uploadRoot(workspace)
  const count = async (path: string): Promise<number> =>
    (await directoryNames(path)).filter((name) => name.endsWith('.json')).length
  const current = (await readJson<Record<string, unknown>>(join(base, 'health.json'))) ?? {}
  await writeJsonAtomic(join(base, 'health.json'), {
    ...current,
    version: 1,
    enabled: env.SCRY_TURN_UPLOAD_ENABLED !== '0' && state?.uploadEnabled !== false,
    pendingCount: await count(join(base, 'outbox')),
    deadLetterCount: await count(join(base, 'dead-letter')),
    enqueuedThrough: state?.enqueuedThrough ?? 0,
    redactionVersion: state?.redactionVersion ?? REDACTION_VERSION,
    ...changes
  })
}

export async function localUploadStatus(workspace: string): Promise<Record<string, unknown>> {
  const base = uploadRoot(workspace)
  const state = await readUploadState(workspace)
  const count = async (path: string): Promise<number> =>
    (await directoryNames(path)).filter((name) => name.endsWith('.json')).length
  let committedPending = 0
  let disabledHeld = 0
  for (const name of await directoryNames(join(base, 'receipts'))) {
    if (!name.endsWith('.json')) continue
    const receipt = await readReceipt(base, name.slice(0, -5))
    if (receipt?.status === 'pending') committedPending++
    if (receipt?.status === 'skipped_disabled') disabledHeld++
  }
  let retryingJobs = 0
  let nextRetry: number | undefined
  for (const name of await readdir(join(base, 'jobs')).catch(() => []))
    if (name.endsWith('.json')) {
      const job = await readJson<{ attempts?: number; notBeforeMs?: number }>(join(base, 'jobs', name)).catch(
        () => null
      )
      if ((job?.attempts ?? 0) > 0) retryingJobs++
      if (Number(job?.notBeforeMs) > Date.now())
        nextRetry = Math.min(nextRetry ?? Infinity, Number(job?.notBeforeMs))
    }
  let timeoutRecords = 0
  for (const path of await outboxPaths(workspace).catch(() => [])) {
    const envelope = await readJson<OutboxEnvelope>(path).catch(() => null)
    if (envelope?.localRetry) {
      timeoutRecords++
      if (envelope.localRetry.notBeforeMs > Date.now())
        nextRetry = Math.min(nextRetry ?? Infinity, envelope.localRetry.notBeforeMs)
    }
  }
  return {
    initialized: state?.version === 1,
    enqueuedThrough: state?.enqueuedThrough ?? 0,
    workspaceId: state?.workspaceId,
    uploadEnabled: state?.uploadEnabled,
    disabledThrough: state?.disabledThrough,
    enabledEpoch: state?.enabledEpoch,
    disabledEpoch: state?.disabledEpoch,
    outboxPending: await count(join(base, 'outbox')),
    committedPending,
    disabledHeld,
    jobsPending: await count(join(base, 'jobs')),
    deadLetterRecords: await count(join(base, 'dead-letter')),
    deadLetterJobs: await count(join(base, 'jobs', 'dead-letter')),
    retryingJobs,
    timeoutRecords,
    nextRetryAt: nextRetry === undefined ? undefined : new Date(nextRetry).toISOString(),
    lastSuccessAt: state?.lastSuccessAt,
    lastError: state?.lastError
  }
}
