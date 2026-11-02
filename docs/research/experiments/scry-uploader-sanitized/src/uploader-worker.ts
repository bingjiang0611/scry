import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  actorIdentity,
  callSubmitTurns,
  reportArguments,
  repositoryName,
  toolArgumentStyle
} from './transport.js'
import { admissionRetryAt, deferUploadAdmission } from './admission.js'
import {
  MAX_BATCH_BYTES,
  MAX_REQUESTS_PER_RUN,
  MIN_REPORT_BUDGET_MS,
  UPLOADER_VERSION,
  UNKNOWN_BATCH_SPLIT_ATTEMPTS
} from './constants.js'
import {
  finishCustody
} from './custody/index.js'
import { UploadError } from './errors.js'
import { classifyTransport, deferLocal, localAttempts, retryAt } from './retry.js'
import {
  uploadRoot
} from './storage.js'
import type { OutboxEnvelope } from './types.js'
import {
  ensurePrivateDirectory, object,
  readJson,
  writeFileAtomic,
  writeJsonAtomic
} from './util.js'
import { encodeRecordForWire } from './wire.js'
export { pruneAckedBodies, releaseDisabled, takeCustody } from './custody/index.js'
export { UploadError } from './errors.js'
export { dataRoot, prepareUploadRoot, uploadRoot } from './storage.js'

import { nextBatch } from './uploader-batch.js'
import { deadLetter, loadEnvelope, outboxPaths } from './uploader-custody.js'

export function validateReportResponse(
  data: unknown,
  batch: Array<[string, OutboxEnvelope]>
): Array<Record<string, unknown>> {
  const root = object(data)
  if (
    !root ||
    !Array.isArray(root.items) ||
    root.items.length !== batch.length ||
    Number(root.received) !== batch.length
  )
    throw new UploadError('invalid_mcp_response', 'submitTurns response count mismatch', true)
  const ordered: Array<Record<string, unknown> | undefined> = new Array(batch.length)
  for (const raw of root.items) {
    const item = object(raw)
    const index = Number(item?.index)
    if (
      !item ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= batch.length ||
      ordered[index] ||
      item.recordId !== batch[index][1].recordId ||
      !['inserted', 'duplicated', 'conflicted', 'rejected'].includes(String(item.status))
    )
      throw new UploadError('invalid_mcp_response', 'submitTurns item invalid', true)
    ordered[index] = item
  }
  const result = ordered as Record<string, unknown>[]
  for (const status of ['inserted', 'duplicated', 'conflicted', 'rejected'])
    if (Number(root[status]) !== result.filter((item) => item.status === status).length)
      throw new UploadError('invalid_mcp_response', 'submitTurns 计数不匹配', true)
  return result
}


export async function uploadPending(
  workspace: string,
  deadline: number,
  env: NodeJS.ProcessEnv,
  timings: Record<string, number>,
  // Last acknowledged upload in this workspace. A record that keeps failing
  // while something else was acknowledged after its first failure is provably
  // the problem; without that proof an outage looks exactly the same.
  options: { lastSuccessAtMs?: number } = {}
): Promise<{
  uploaded: number
  duplicated: number
  deadLettered: number
  retryAtMs?: number
  deferredUntilMs?: number
  /** True only when the endpoint itself failed, not when work was merely deferred. */
  endpointFailed?: boolean
}> {
  const summary: {
    uploaded: number
    duplicated: number
    deadLettered: number
    deferredUntilMs?: number
    endpointFailed?: boolean
  } = {
    uploaded: 0,
    duplicated: 0,
    deadLettered: 0
  }
  const deferred = new Set<string>()
  const pendingBatches: Array<Array<[string, OutboxEnvelope]>> = []
  let retryAtMs: number | undefined
  let requests = 0
  let probedUnknown = false
  if (!(await outboxPaths(workspace)).length) return summary
  let context:
    | {
        actor: Awaited<ReturnType<typeof actorIdentity>>
        repo: string
        style: Awaited<ReturnType<typeof toolArgumentStyle>>
        iid: string
      }
    | undefined
  while (true) {
    if (Date.now() >= deadline) {
      summary.deferredUntilMs = Date.now() + 100
      return summary
    }
    // Never start a request the remaining budget cannot finish: our own
    // deadline would kill it and the batch would be charged as a server
    // timeout even though the server was healthy.
    if (requests >= MAX_REQUESTS_PER_RUN || deadline - Date.now() < MIN_REPORT_BUDGET_MS) {
      summary.deferredUntilMs = Date.now() + 5_000
      return summary
    }
    const userCooldown = await admissionRetryAt(env)
    if (userCooldown) {
      summary.deferredUntilMs = userCooldown
      return summary
    }
    const batch = pendingBatches.shift() ?? (await nextBatch(workspace, deferred, summary))
    if (!batch.length) {
      for (const path of deferred) {
        const envelope = await loadEnvelope(path)
        retryAtMs = Math.min(retryAtMs ?? Infinity, retryAt(envelope))
      }
      if (retryAtMs) {
        summary.deferredUntilMs = retryAtMs
        return summary
      }
      return summary
    }
    if (!context) {
      const actor = await transportStage('actor', timings, () =>
        actorIdentity(env, remainingTimeout(deadline, 15_000))
      )
      const repo = await transportStage('repository', timings, () =>
        repositoryName(workspace, remainingTimeout(deadline, 5_000))
      )
      const style = await transportStage('initialize', timings, () =>
        toolArgumentStyle(env, remainingTimeout(deadline, 30_000))
      )
      context = { actor, repo, style, iid: await workspaceInstallationId(workspace, env) }
    }
    const { actor, repo, style, iid } = context
    let active = batch
    let data: unknown
    while (true) {
      const values = {
        actorUserId: actor.userId,
        actorNick: actor.nick,
        repo,
        installationId: iid,
        uploaderVersion: UPLOADER_VERSION,
        redactionVersion: active[0][1].redactionVersion,
        records: active.map(([, envelope]) => encodeRecordForWire(envelope.record))
      }
      const serialized = JSON.stringify(reportArguments(values, style))
      if (Buffer.byteLength(serialized) > MAX_BATCH_BYTES) {
        if (active.length > 1) {
          const cut = Math.ceil(active.length / 2)
          pendingBatches.unshift(active.slice(cut))
          active = active.slice(0, cut)
          continue
        }
        await deadLetter(workspace, active[0][0], active[0][1], 'rejected', 'oversize_wire_record')
        summary.deadLettered++
        data = undefined
        break
      }
      // Preparation can consume most of the budget, so re-check right before the
      // request: a request killed by our own deadline is not a server timeout.
      if (requests >= MAX_REQUESTS_PER_RUN || deadline - Date.now() < MIN_REPORT_BUDGET_MS) {
        summary.deferredUntilMs = Date.now() + 5_000
        return summary
      }
      try {
        requests++
        data = await transportStage('submitTurns', timings, () =>
          callSubmitTurns(serialized, env, remainingTimeout(deadline, 115_000))
        )
        break
      } catch (error) {
        const classified = classifyTransport(error)
        if (
          classified.kind === 'deterministic' &&
          active.length > 1
        ) {
          const cut = Math.max(1, Math.ceil(active.length / 2))
          pendingBatches.unshift(active.slice(cut))
          active = active.slice(0, cut)
          continue
        }
        if (classified.kind === 'auth') {
          const failure = new UploadError(
            'transport_auth',
            'uploader authentication failed; run transport auth login --sso',
            true,
            Date.now() + 15 * 60_000,
            { cause: error }
          )
          failure.statusCode = classified.details.statusCode
          failure.stderr = classified.details.stderr?.slice(0, 512)
          throw failure
        }
        if (classified.kind === 'transient' || classified.kind === 'timeout') {
          if (classified.details.retryAfterMs !== undefined)
            await deferUploadAdmission(env, Math.ceil(classified.details.retryAfterMs))
          const kind = classified.kind === 'timeout' ? 'report_timeout' : 'report_transient'
          for (const [path, envelope] of active) {
            // Transport retries are local cooldown state, not the durable job
            // or record terminal budget. Keep the custody bytes until a remote
            // acknowledgement or an explicit deterministic rejection.
            retryAtMs = Math.min(
              retryAtMs ?? Infinity,
              await deferLocal(path, envelope, kind, classified.kind, classified.details.retryAfterMs)
            )
            deferred.add(path)
          }
          summary.endpointFailed = true
          if (retryAtMs !== undefined && retryAtMs !== Infinity) {
            summary.deferredUntilMs = retryAtMs
            return summary
          }
          data = undefined
          break
        }
        if (classified.kind === 'unknown') {
          // An unrecognised failure (for example a business error returned with
          // success:false and no status) is ambiguous: the record may be bad, or
          // the whole service may be unavailable. Record budgets and bisecting
          // are only justified once this run proved the endpoint works, either by
          // uploading another record or by succeeding on a probed batch. Without
          // that evidence a service-wide outage would feed intact records into
          // the dead-letter queue one by one.
          const [headPath, headEnvelope] = active[0]
          const acknowledged = (options.lastSuccessAtMs ?? 0) > (headEnvelope.localRetry?.firstAtMs ?? Infinity)
          if (summary.uploaded + summary.duplicated === 0 && !acknowledged) {
            if (active.length > 1 && !probedUnknown) {
              // No evidence yet: probe one half instead of bisecting the whole
              // batch. A success is the only cheap proof that the service works
              // and that the other half is the problem.
              probedUnknown = true
              const cut = Math.max(1, Math.ceil(active.length / 2))
              pendingBatches.unshift(active.slice(0, cut))
              active = active.slice(cut)
              continue
            }
            // Every request this run failed: charge the workspace cooldown only.
            // Record budgets and bisecting stay untouched so an outage cannot
            // dead-letter intact records.
            summary.endpointFailed = true
            for (const [path, envelope] of active) {
              retryAtMs = Math.min(
                retryAtMs ?? Infinity,
                await deferLocal(
                  path,
                  envelope,
                  'report_unknown',
                  'report_unknown_service',
                  classified.details.retryAfterMs,
                  { count: false }
                )
              )
              deferred.add(path)
            }
            if (retryAtMs !== undefined && retryAtMs !== Infinity) summary.deferredUntilMs = retryAtMs
            return summary
          }
          if (localAttempts(headEnvelope, 'report_unknown') + 1 >= UNKNOWN_BATCH_SPLIT_ATTEMPTS) {
            if (active.length > 1) {
              const cut = Math.max(1, Math.ceil(active.length / 2))
              pendingBatches.unshift(active.slice(cut))
              active = active.slice(0, cut)
              continue
            }
            await deadLetter(workspace, headPath, headEnvelope, 'rejected', 'report_unknown_exhausted')
            summary.deadLettered++
            data = undefined
            break
          }
          summary.endpointFailed = true
          retryAtMs = Math.min(
            retryAtMs ?? Infinity,
            await deferLocal(headPath, headEnvelope, 'report_unknown', 'report_unknown', classified.details.retryAfterMs)
          )
          deferred.add(headPath)
          if (retryAtMs !== undefined && retryAtMs !== Infinity) {
            summary.deferredUntilMs = retryAtMs
            return summary
          }
          data = undefined
          break
        }
        if (classified.kind === 'deterministic') {
          const [, envelope] = active[0]
          const [path] = active[0]
          if (localAttempts(envelope, 'report_request') + 1 >= 3) {
            await deadLetter(workspace, path, envelope, 'rejected', 'report_request_exhausted')
            summary.deadLettered++
          } else {
            retryAtMs = Math.min(
              retryAtMs ?? Infinity,
              await deferLocal(path, envelope, 'report_request', 'report_request', classified.details.retryAfterMs)
            )
            deferred.add(path)
          }
          data = undefined
          break
        }
        // transportStage already owns the stage-specific envelope. Keep its
        // status/signal/stderr metadata instead of routing through a dead
        // generic report_failed branch.
        if (error instanceof UploadError) {
          error.deferJobAttempt = true
          throw error
        }
        throw new UploadError('transport_submitTurns', 'report transport failed', true, undefined, {
          cause: error
        })
      }
    }
    if (data === undefined) continue
    const items = validateReportResponse(data, active)
    for (let index = 0; index < active.length; index++) {
      const [path, envelope] = active[index]
      const status = String(items[index].status)
      if (status === 'inserted' || status === 'duplicated') {
        await finishCustody(workspace, envelope, 'uploaded', status)
        await unlink(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
        summary.uploaded++
        if (status === 'duplicated') summary.duplicated++
      } else {
        await deadLetter(workspace, path, envelope, status, status)
        summary.deadLettered++
      }
    }
  }
}

async function workspaceInstallationId(workspace: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (env.SCRY_INSTALLATION_ID?.trim()) return env.SCRY_INSTALLATION_ID.trim().slice(0, 64)
  const path = join(uploadRoot(workspace), 'installation.json')
  const existing = await readJson<{ installationId?: unknown }>(path)
  if (existing) {
    if (typeof existing.installationId !== 'string' || !existing.installationId.trim())
      throw new UploadError('invalid_installation_id', basename(path))
    return existing.installationId.trim().slice(0, 64)
  }
  const configured =
    env.SCRY_INSTALLATION_ID_FILE?.trim() ||
    join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'scry', 'installation-id')
  let value: string
  try {
    value = (await readFile(configured, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    value = randomUUID()
    await ensurePrivateDirectory(dirname(configured))
    await writeFileAtomic(configured, `${value}\n`)
  }
  await writeJsonAtomic(path, { version: 1, installationId: value })
  return value.slice(0, 64)
}

async function transportStage<T>(
  stage: string,
  timings: Record<string, number>,
  action: () => Promise<T>
): Promise<T> {
  const started = Date.now()
  try {
    return await action()
  } catch (error) {
    const classified = classifyTransport(error)
    const failure =
      error instanceof UploadError
        ? error
        : new UploadError(
            classified.kind === 'auth' ? 'transport_auth' : `transport_${stage}`,
            classified.kind === 'auth'
              ? 'uploader authentication failed; run transport auth login --sso'
              : `${stage} failed (${error instanceof Error ? error.name : 'unknown'})`,
            true,
            classified.kind === 'auth'
              ? Date.now() + 15 * 60_000
              : classified.details.retryAfterMs,
            { cause: error }
          )
    failure.stage = stage
    failure.durationMs = Date.now() - started
    failure.errorType = error instanceof Error ? error.name : 'unknown'
    failure.statusCode = classified.details.statusCode
    failure.exitCode = classified.details.exitCode
    failure.retryAfterMs = classified.details.retryAfterMs
    failure.signal = classified.details.signal
    failure.stderr = classified.details.stderr?.slice(0, 512)
    if (classified.kind === 'timeout' || classified.kind === 'transient' || classified.kind === 'unknown')
      failure.deferJobAttempt = true
    throw failure
  } finally {
    timings[stage] = (timings[stage] ?? 0) + Date.now() - started
  }
}

function remainingTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new UploadError('upload_deadline_exhausted', 'upload deadline exhausted', true)
  return Math.min(maximum, remaining)
}
