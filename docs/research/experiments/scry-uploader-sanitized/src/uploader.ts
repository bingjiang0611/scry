import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, readdir, rename, unlink } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  PROVIDERS,
  LEGACY_REDACTION_VERSION,
  MAX_BATCH_BYTES,
  MAX_BATCH_RECORDS,
  UPLOADER_VERSION,
  MAX_RECORD_BYTES,
  MAX_REPORT_TIMEOUT_ATTEMPTS,
  MAX_TIMEOUT_SPLITS,
  REDACTION_VERSION,
  TIMEOUT_RETRY_BASE_SECONDS,
  TIMEOUT_RETRY_MAX_SECONDS,
  UPLOAD_DEADLINE_SECONDS
} from './constants.js'
import {
  actorIdentity,
  callSubmitTurns,
  reportArguments,
  repositoryName,
  toolArgumentStyle
} from './transport.js'
import { encodeRecordForWire } from './wire.js'
import { exportPage } from './scry.js'
import type { CustodyReceipt, OutboxEnvelope, UploadState, UploadSummary } from './types.js'
import {
  acquireDirectoryLock,
  ensurePrivateDirectory,
  exists,
  now,
  object,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
  syncDirectory,
  sleep
} from './util.js'
import { UploadError } from './errors.js'
import { validateEnvelope } from './envelope.js'
import {
  dataRoot,
  uploadRoot,
  prepareUploadRoot,
  assertLegacyLocksMigrated,
  recordFilename,
  digest
} from './storage.js'
import {
  readReceipt,
  readCustody,
  takeCustody,
  retainEnvelope,
  finishCustody,
  pausePending
} from './custody/index.js'
export { UploadError } from './errors.js'
export { dataRoot, uploadRoot, prepareUploadRoot } from './storage.js'
export { takeCustody, releaseDisabled } from './custody/index.js'

const RECORD_ID_RE = /^[a-f0-9]{32,64}$/

function statePath(workspace: string): string {
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

function sourceIdentity(
  record: unknown,
  workspace: string,
  state: UploadState
): { sequence: number; recordId: string; workspaceId: string } {
  const root = object(record)
  const ws = object(root?.workspace)
  const sequence = root?.sequence
  const recordId = typeof root?.recordId === 'string' ? root.recordId : ''
  const workspaceId = typeof ws?.id === 'string' ? ws.id : ''
  const recordRoot = typeof ws?.root === 'string' ? ws.root : ''
  if (root?.schemaVersion !== 1)
    throw new UploadError('unsupported_schema_version', 'AgentTurnRecord schema unsupported')
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1 || !RECORD_ID_RE.test(recordId))
    throw new UploadError('invalid_record', 'AgentTurnRecord identity invalid')
  let sameRoot = false
  if (recordRoot) {
    try {
      sameRoot = realpathSync(recordRoot) === realpathSync(workspace)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!workspaceId || !sameRoot) throw new UploadError('workspace_mismatch', 'record workspace mismatch')
  if (state.workspaceId && state.workspaceId !== workspaceId)
    throw new UploadError('workspace_mismatch', 'workspaceId changed')
  return { sequence: Number(sequence), recordId, workspaceId }
}

async function loadEnvelope(path: string, verifyCustody = true): Promise<OutboxEnvelope> {
  let value: unknown
  try {
    value = await readJson<unknown>(path)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new UploadError('invalid_outbox', basename(path))
  }
  const envelope = validateEnvelope(value, path)
  if (verifyCustody) {
    const base = dirname(dirname(path))
    const receipt = await readReceipt(base, envelope.recordId)
    if (receipt) {
      if (receipt.sequence !== envelope.sequence)
        throw new UploadError('custody_identity_mismatch', basename(path), true)
      const raw = await readCustody(base, receipt)
      if (envelope.redactionVersion === REDACTION_VERSION && digest(raw) !== digest(envelope.record)) {
        throw new UploadError('custody_digest_mismatch', basename(path), true)
      }
    }
  }
  return envelope
}

async function persistOutbox(
  workspace: string,
  identity: { sequence: number; recordId: string; workspaceId: string },
  record: string,
  redactionVersion = REDACTION_VERSION
): Promise<void> {
  const path = join(uploadRoot(workspace), 'outbox', recordFilename(identity.sequence, identity.recordId))
  const envelope: OutboxEnvelope = {
    version: 1,
    sequence: identity.sequence,
    recordId: identity.recordId,
    workspaceId: identity.workspaceId,
    redactionVersion,
    recordBytes: Buffer.byteLength(record),
    record,
    sha256: digest(Buffer.from(record))
  }
  const existing = await readJson<unknown>(path)
  if (existing) {
    const prior = validateEnvelope(existing, path)
    if (
      prior.recordId !== envelope.recordId ||
      prior.sequence !== envelope.sequence ||
      prior.workspaceId !== envelope.workspaceId
    )
      throw new UploadError('outbox_conflict', basename(path), true)
    if (prior.redactionVersion === LEGACY_REDACTION_VERSION) return
    if (prior.record !== record) {
      if (!isDeepStrictEqual(JSON.parse(prior.record), JSON.parse(record))) {
        throw new UploadError('outbox_conflict', basename(path), true)
      }
      await writeJsonAtomic(path, {
        ...prior,
        record,
        recordBytes: envelope.recordBytes,
        sha256: envelope.sha256
      })
    }
    return
  }
  await writeJsonAtomic(path, envelope)
}

async function markCustodyDead(workspace: string, receipt: CustodyReceipt, reason: string): Promise<void> {
  const raw = await readCustody(uploadRoot(workspace), receipt)
  await deadLetter(
    workspace,
    join(uploadRoot(workspace), 'outbox', recordFilename(receipt.sequence, receipt.recordId)),
    {
      version: 1,
      recordId: receipt.recordId,
      sequence: receipt.sequence,
      workspaceId: '',
      record: raw.toString('utf8'),
      recordBytes: raw.length,
      redactionVersion: REDACTION_VERSION,
      sha256: digest(raw)
    },
    'rejected',
    reason
  )
}

async function enqueueCustody(workspace: string, state: UploadState, receipt: CustodyReceipt): Promise<void> {
  if (receipt.status !== 'pending') return
  const raw = await readCustody(uploadRoot(workspace), receipt)
  const path = join(uploadRoot(workspace), 'outbox', recordFilename(receipt.sequence, receipt.recordId))
  const prior = await readJson<unknown>(path)
  if (prior) {
    const envelope = validateEnvelope(prior, path)
    if (envelope.redactionVersion === LEGACY_REDACTION_VERSION) {
      if (state.workspaceId && state.workspaceId !== envelope.workspaceId) {
        throw new UploadError('workspace_mismatch', 'legacy outbox workspace changed', true)
      }
      state.workspaceId = envelope.workspaceId
      return
    }
  }
  let record: unknown
  try {
    record = JSON.parse(raw.toString('utf8'))
  } catch {
    await markCustodyDead(workspace, receipt, 'invalid_record')
    return
  }
  try {
    const identity = sourceIdentity(record, workspace, state)
    if (identity.sequence !== receipt.sequence || identity.recordId !== receipt.recordId)
      throw new UploadError('custody_identity_mismatch', 'custody identity mismatch')
    await persistOutbox(workspace, identity, raw.toString('utf8'), REDACTION_VERSION)
    state.workspaceId = identity.workspaceId
  } catch (error) {
    if (
      error instanceof UploadError &&
      [
        'invalid_record',
        'unsupported_schema_version',
        'workspace_mismatch',
        'custody_identity_mismatch'
      ].includes(error.code)
    ) {
      await markCustodyDead(workspace, receipt, error.code)
      return
    }
    throw error
  }
}

async function enqueueCommitted(
  workspace: string,
  state: UploadState,
  expected?: {
    sequence: number
    recordId: string
    provider?: string
    sessionId?: string
  }
): Promise<void> {
  const base = uploadRoot(workspace)
  if (expected) {
    let receipt = await readReceipt(base, expected.recordId)
    if (!receipt) {
      const path = join(base, 'outbox', recordFilename(expected.sequence, expected.recordId))
      if ((await exists(path)) && !(await exists(join(dataRoot(workspace), 'records', basename(path))))) {
        receipt = await retainEnvelope(workspace, await loadEnvelope(path))
      } else {
        receipt = await takeCustody(workspace, { ...expected })
      }
    }
    if (
      !receipt ||
      receipt.sequence !== expected.sequence ||
      (expected.provider && receipt.provider !== undefined && receipt.provider !== expected.provider) ||
      (expected.sessionId && receipt.sessionId !== undefined && receipt.sessionId !== expected.sessionId)
    )
      throw new UploadError(
        'record_commit_not_custodied',
        'canonical committed record is not available',
        true
      )
    await enqueueCustody(workspace, state, receipt)
    return
  }
  for (const path of await readdir(join(base, 'receipts'))) {
    if (!path.endsWith('.json')) continue
    const receipt = await readReceipt(base, path.slice(0, -5))
    if (receipt) await enqueueCustody(workspace, state, receipt)
  }
}

async function enqueueSnapshot(
  workspace: string,
  state: UploadState,
  env: NodeJS.ProcessEnv,
  deadline: number
): Promise<number> {
  let cursor = state.enqueuedThrough
  let snapshot: number | undefined
  let count = 0
  while (true) {
    const page = await exportPage(workspace, cursor, snapshot, remainingTimeout(deadline, 30_000), env)
    if (snapshot === undefined) snapshot = page.snapshotMaxSequence
    if (snapshot !== page.snapshotMaxSequence)
      throw new UploadError('export_snapshot_changed', 'snapshot changed', true)
    let previous = cursor
    for (const record of page.records) {
      const value = object(record)
      const sequence = value?.sequence
      const recordId = value?.recordId
      if (!Number.isSafeInteger(sequence) || typeof recordId !== 'string' || !RECORD_ID_RE.test(recordId)) {
        throw new UploadError('invalid_record', 'export record identity invalid')
      }
      if (Number(sequence) <= previous || Number(sequence) > snapshot) {
        throw new UploadError('export_sequence_invalid', 'export sequence invalid', true)
      }
      const custody = await readReceipt(uploadRoot(workspace), recordId)
      if (custody) {
        if (custody.sequence !== sequence) throw new UploadError('custody_identity_mismatch', recordId, true)
        await enqueueCustody(workspace, state, custody)
      } else {
        const identity = sourceIdentity(record, workspace, state)
        await persistOutbox(workspace, identity, JSON.stringify(record))
        state.workspaceId = identity.workspaceId
      }
      previous = Number(sequence)
      count++
    }
    if (page.nextCursor !== previous)
      throw new UploadError('export_cursor_mismatch', 'export cursor mismatch', true)
    if (page.hasMore && page.nextCursor <= cursor)
      throw new UploadError('export_cursor_stalled', 'export cursor stalled', true)
    state.enqueuedThrough = page.nextCursor
    await writeJsonAtomic(statePath(workspace), state)
    cursor = page.nextCursor
    if (!page.hasMore) return count
  }
}

async function outboxPaths(workspace: string): Promise<string[]> {
  return (await readdir(join(uploadRoot(workspace), 'outbox')))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(uploadRoot(workspace), 'outbox', name))
}

async function quarantineInvalidOutbox(workspace: string, path: string): Promise<void> {
  await rename(path, join(uploadRoot(workspace), 'dead-letter', `${Date.now()}-invalid-${basename(path)}`))
}
async function deadLetter(
  workspace: string,
  path: string,
  envelope: OutboxEnvelope,
  status: string,
  reason: string
): Promise<void> {
  const base = uploadRoot(workspace)
  const retained = await retainEnvelope(workspace, envelope)
  const legacyVariant =
    envelope.redactionVersion === LEGACY_REDACTION_VERSION && retained.sha256 !== digest(envelope.record)
  await writeJsonAtomic(join(base, 'dead-letter', recordFilename(envelope.sequence, envelope.recordId)), {
    recordId: envelope.recordId,
    sequence: envelope.sequence,
    sha256: digest(Buffer.from(envelope.record)),
    redactionVersion: envelope.redactionVersion,
    payloadPath: `outbox/committed/${legacyVariant ? 'legacy/' : ''}${recordFilename(envelope.sequence, envelope.recordId)}`,
    remoteStatus: status,
    reason: [
      'oversize_record',
      'invalid_record',
      'unsupported_schema_version',
      'workspace_mismatch',
      'custody_identity_mismatch',
      'report_timeout_exhausted'
    ].includes(reason)
      ? reason
      : `remote_${status}`,
    failedAt: now()
  })
  await finishCustody(workspace, envelope, 'dead_letter', status)
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await syncDirectory(dirname(path))
}

function timeoutAt(envelope: OutboxEnvelope): number {
  return envelope.localRetry?.kind === 'report_timeout' ? Number(envelope.localRetry.notBeforeMs) || 0 : 0
}
function timeoutAttempts(envelope: OutboxEnvelope): number {
  return envelope.localRetry?.kind === 'report_timeout' ? Number(envelope.localRetry.attempts) || 0 : 0
}
async function deferTimeout(path: string, envelope: OutboxEnvelope): Promise<number> {
  const attempts = timeoutAttempts(envelope) + 1
  const delay = Math.min(
    TIMEOUT_RETRY_MAX_SECONDS,
    TIMEOUT_RETRY_BASE_SECONDS * 2 ** Math.min(attempts - 1, 4)
  )
  const next = Date.now() + delay * 1000
  await writeJsonAtomic(path, {
    ...envelope,
    localRetry: { kind: 'report_timeout', attempts, notBeforeMs: next }
  })
  return next
}

async function nextBatch(
  workspace: string,
  deferred: Set<string>,
  summary: { deadLettered: number }
): Promise<Array<[string, OutboxEnvelope]>> {
  const batch: Array<[string, OutboxEnvelope]> = []
  let size = 0
  for (const path of await outboxPaths(workspace)) {
    if (deferred.has(path)) continue
    let envelope: OutboxEnvelope
    try {
      envelope = await loadEnvelope(path)
    } catch (error) {
      if (error instanceof UploadError && error.code === 'invalid_outbox') {
        await quarantineInvalidOutbox(workspace, path)
        summary.deadLettered++
        continue
      }
      throw error
    }
    const receipt = await readReceipt(uploadRoot(workspace), envelope.recordId)
    if (receipt?.status === 'skipped_disabled') continue
    if (receipt && receipt.status !== 'pending') {
      await unlink(path)
      await syncDirectory(dirname(path))
      continue
    }
    if (timeoutAt(envelope) > Date.now()) {
      deferred.add(path)
      continue
    }
    if (envelope.recordBytes > MAX_RECORD_BYTES) {
      await deadLetter(workspace, path, envelope, 'rejected', 'oversize_record')
      summary.deadLettered++
      continue
    }
    if (
      batch.length &&
      (batch.length >= MAX_BATCH_RECORDS ||
        size + envelope.recordBytes > MAX_BATCH_BYTES ||
        envelope.redactionVersion !== batch[0][1].redactionVersion)
    )
      break
    batch.push([path, envelope])
    size += envelope.recordBytes
  }
  return batch
}
function smallerPrefix(batch: Array<[string, OutboxEnvelope]>): Array<[string, OutboxEnvelope]> {
  if (batch.length < 2) return []
  const target = Math.ceil(batch.reduce((s, [, e]) => s + e.recordBytes, 0) / 2)
  let size = 0
  const prefix: Array<[string, OutboxEnvelope]> = []
  for (const item of batch.slice(0, -1)) {
    if (prefix.length && size + item[1].recordBytes > target) break
    prefix.push(item)
    size += item[1].recordBytes
    if (size >= target) break
  }
  return prefix.length ? prefix : batch.slice(0, 1)
}

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

function isTimeout(error: unknown): boolean {
  let current: unknown = error
  for (let i = 0; i < 6 && current instanceof Error; i++) {
    if ((current as Error & { code?: string }).code === 'ETIMEDOUT' || /timeout/i.test(current.message))
      return true
    current = current.cause
  }
  return false
}

async function uploadPending(
  workspace: string,
  deadline: number,
  env: NodeJS.ProcessEnv,
  timings: Record<string, number>
): Promise<{
  uploaded: number
  duplicated: number
  deadLettered: number
  retryAtMs?: number
}> {
  const summary = { uploaded: 0, duplicated: 0, deadLettered: 0 }
  const deferred = new Set<string>()
  let retryAtMs: number | undefined
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
    if (Date.now() >= deadline)
      throw new UploadError('upload_deadline_exhausted', 'upload deadline exhausted', true)
    const batch = await nextBatch(workspace, deferred, summary)
    if (!batch.length) {
      for (const path of deferred) {
        retryAtMs = Math.min(retryAtMs ?? Infinity, timeoutAt(await loadEnvelope(path)))
      }
      if (retryAtMs)
        throw new UploadError('report_timeout_cooldown', 'report timeout cooldown', true, retryAtMs)
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
    let split = 0
    let data: unknown
    while (true) {
      try {
        const values = {
          actorUserId: actor.userId,
          actorNick: actor.nick,
          repo,
          installationId: iid,
          uploaderVersion: UPLOADER_VERSION,
          redactionVersion: active[0][1].redactionVersion,
          records: active.map(([, envelope]) => encodeRecordForWire(envelope.record))
        }
        data = await transportStage('submitTurns', timings, () =>
          callSubmitTurns(reportArguments(values, style), env, remainingTimeout(deadline, 115_000))
        )
        break
      } catch (error) {
        if (
          isTimeout(error) &&
          active.length > 1 &&
          split < MAX_TIMEOUT_SPLITS &&
          deadline - Date.now() > 20_000
        ) {
          active = smallerPrefix(active)
          split++
          continue
        }
        if (!isTimeout(error) && error instanceof UploadError) throw error
        if (!isTimeout(error))
          throw new UploadError(
            'report_failed',
            error instanceof Error ? error.message : String(error),
            true,
            undefined,
            { cause: error }
          )
        for (const [path, envelope] of active) {
          if (timeoutAttempts(envelope) + 1 >= MAX_REPORT_TIMEOUT_ATTEMPTS) {
            await deadLetter(workspace, path, envelope, 'unknown', 'report_timeout_exhausted')
            summary.deadLettered++
          } else {
            retryAtMs = Math.min(retryAtMs ?? Infinity, await deferTimeout(path, envelope))
            deferred.add(path)
          }
        }
        data = undefined
        break
      }
    }
    if (data === undefined) continue
    const items = validateReportResponse(data, active)
    for (let index = 0; index < active.length; index++) {
      const [path, envelope] = active[index]
      const status = String(items[index].status)
      if (status === 'inserted' || status === 'duplicated') {
        await finishCustody(workspace, envelope, 'uploaded', status)
        await unlink(path).catch(() => undefined)
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

async function directoryNames(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
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

function remainingTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new UploadError('upload_deadline_exhausted', 'upload deadline exhausted', true)
  return Math.min(maximum, remaining)
}

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
      if (!(error instanceof Error) || error.message !== 'upload worker is already running') throw error
      if (Date.now() >= deadline)
        throw new UploadError('upload_locked', 'upload worker is already running', true)
      await sleep(Math.min(100, deadline - Date.now()))
    }
  }
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
    const failure =
      error instanceof UploadError
        ? error
        : new UploadError(
            `transport_${stage}`,
            `${stage} failed (${error instanceof Error ? error.name : 'unknown'})`,
            true,
            undefined,
            { cause: error }
          )
    failure.stage = stage
    failure.durationMs = Date.now() - started
    failure.errorType = error instanceof Error ? error.name : 'unknown'
    throw failure
  } finally {
    timings[stage] = (timings[stage] ?? 0) + Date.now() - started
  }
}

export async function runUpload(
  workspace: string,
  options: {
    expected?: { sequence: number; recordId: string; provider?: string; sessionId?: string }
    env?: NodeJS.ProcessEnv
    mode?: 'flush' | 'wakeup' | 'record-commit'
  } = {}
): Promise<UploadSummary> {
  const env = options.env ?? process.env
  const empty = { enqueued: 0, uploaded: 0, duplicated: 0, deadLettered: 0, pending: 0 }
  if (env.SCRY_RECORDER_ENABLED === '0') return empty
  const deadline = Date.now() + uploadDeadline(env) * 1_000
  const preparationDeadline = Math.min(deadline, Date.now() + 40_000)
  const base = await prepareUploadRoot(workspace)
  let release: (() => Promise<void>) | undefined
  let state: UploadState | null = null
  const timings: Record<string, number> = {}
  try {
    await assertLegacyLocksMigrated(base)
    release = await acquireUploadLock(base, env, preparationDeadline)
    state = await initializeUploadState(workspace, 0)
    if (env.SCRY_TURN_UPLOAD_ENABLED === '0') {
      await pausePending(workspace)
      await updateHealth(
        workspace,
        state,
        { status: 'disabled', currentAttemptId: null, currentAttemptStartedAt: null },
        env
      )
      return { ...empty, pending: (await outboxPaths(workspace)).length }
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
    await waitForManagedTurn(workspace, env, preparationDeadline)
    await enqueueCommitted(workspace, state, expected)
    const enqueued = expected ? 0 : await enqueueSnapshot(workspace, state, env, preparationDeadline)
    await writeJsonAtomic(statePath(workspace), state)
    await updateHealth(workspace, state, {}, env)
    const uploaded = await uploadPending(workspace, deadline, env, timings)
    const pending = (await outboxPaths(workspace)).length
    state.lastSuccessAt = now()
    delete state.lastError
    await writeJsonAtomic(statePath(workspace), state)
    await updateHealth(
      workspace,
      state,
      {
        status: pending ? 'held_disabled' : 'healthy',
        currentAttemptId: null,
        currentAttemptStartedAt: null,
        lastSuccessAt: state.lastSuccessAt,
        lastUploadedCount: uploaded.uploaded,
        lastErrorCode: null,
        lastErrorAt: null,
        lastTransportStage: null,
        lastTransportDurationMs: null,
        lastTransportErrorType: null,
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
    const failedAt = now()
    if (state) {
      state.lastError = { at: failedAt, code: failure.code, message: failure.message.slice(0, 500) }
      await writeJsonAtomic(statePath(workspace), state)
    }
    await updateHealth(
      workspace,
      state,
      {
        status: 'error',
        currentAttemptId: null,
        currentAttemptStartedAt: null,
        lastErrorCode: failure.code,
        lastErrorAt: failedAt,
        lastTransportStage: failure.stage ?? null,
        lastTransportDurationMs: failure.durationMs ?? null,
        lastTransportErrorType: failure.errorType ?? null,
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
    if (release) await release()
  }
}
function uploadDeadline(env: NodeJS.ProcessEnv): number {
  const value = Number(env.SCRY_UPLOAD_DEADLINE_SECONDS || UPLOAD_DEADLINE_SECONDS)
  return Math.max(30, Math.min(Number.isFinite(value) ? value : UPLOAD_DEADLINE_SECONDS, 280))
}
async function updateHealth(
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
    enabled: env.SCRY_TURN_UPLOAD_ENABLED !== '0',
    pendingCount: await count(join(base, 'outbox')),
    deadLetterCount: await count(join(base, 'dead-letter')),
    enqueuedThrough: state?.enqueuedThrough ?? 0,
    redactionVersion: state?.redactionVersion ?? REDACTION_VERSION,
    ...changes
  })
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
