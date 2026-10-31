import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { JOB_BACKOFF_BASE_MS, JOB_BACKOFF_MAX_MS, JOB_MAX_ATTEMPTS, PROVIDERS } from './constants.js'
import { markWakeupQueued } from './custody/index.js'
import { uploaderEntrypoint } from './scry.js'
import type { QueueJob, RecordCommittedNotification } from './types.js'
import { UploadError, prepareUploadRoot, runUpload, setUploadPolicy, takeCustody, uploadRoot } from './uploader.js'
import {
  acquireDirectoryLock,
  exists,
  now,
  object,
  readJson,
  sleep,
  syncDirectory,
  writeJsonAtomic
} from './util.js'

const RECORD_ID_RE = /^[a-f0-9]{32,64}$/
const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/
const ENV_KEYS = [
  'HOST_TRACE_TASK_ID',
  'HOST_BUSINESS_WORKITEM_ID',
  'HOST_VALIDATION_AGENT',
  'HOST_VALIDATION_BRANCH',
  'HOST_APP_AGENT',
  'HOST_TRACE_SUPPRESS',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'QODER_SESSION_ID',
  'PI_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
  'CODEX_PROJECT_DIR',
  'OPENCODE_PROJECT_DIR',
  'OPENCODE_WORKSPACE_DIR',
  'QODER_PROJECT_DIR',
  'SCRY_CLI_PATH',
  'SCRY_PROVIDER_ID',
  'SCRY_RECORDER_MANAGED',
  'SCRY_UPLOAD_SESSION_ID',
  'SCRY_UPLOAD_TRIGGER',
  'SCRY_UPLOAD_EXPECTED_SEQUENCE',
  'SCRY_UPLOAD_EXPECTED_RECORD_ID',
  'SCRY_UPLOAD_RECORD_ID',
  'SCRY_MANAGED_UPLOAD_WAIT_SECONDS',
  'SCRY_UPLOAD_LOCK_WAIT_SECONDS',
  'SCRY_UPLOAD_DEADLINE_SECONDS',
  'SCRY_RECORDER_ENABLED',
  'SCRY_TURN_UPLOAD_ENABLED',
  'SCRY_INSTALLATION_ID',
  'SCRY_INSTALLATION_ID_FILE',
  'TRANSPORT_CLI_PATH',
  'XDG_STATE_HOME'
]
// Accept old snapshots for migration, but never recover executable, installation,
// admission-directory or current policy authority from repository-owned jobs.
const ACTIVATION_ENV_KEYS = new Set([
  'SCRY_CLI_PATH', 'TRANSPORT_CLI_PATH', 'XDG_STATE_HOME',
  'SCRY_INSTALLATION_ID', 'SCRY_INSTALLATION_ID_FILE',
  'SCRY_MANAGED_UPLOAD_WAIT_SECONDS', 'SCRY_UPLOAD_LOCK_WAIT_SECONDS',
  'SCRY_UPLOAD_DEADLINE_SECONDS', 'SCRY_RECORDER_ENABLED', 'SCRY_TURN_UPLOAD_ENABLED'
])
const CONTEXT_ENV_KEYS = ENV_KEYS.filter(key => !ACTIVATION_ENV_KEYS.has(key))

function queuePath(workspace: string): string {
  return join(uploadRoot(workspace), 'jobs')
}
function safeReason(error: unknown): string {
  return (error instanceof Error ? `${error.name}:${error.message}` : String(error))
    .replace(/[^A-Za-z0-9_.:\- ]+/g, '-')
    .slice(0, 300)
}
function backoff(attempts: number): number {
  const ceiling = Math.min(JOB_BACKOFF_MAX_MS, JOB_BACKOFF_BASE_MS * 2 ** Math.min(18, Math.max(0, attempts - 1)))
  return Math.floor(ceiling * (0.8 + Math.random() * 0.2))
}
function capturedEnv(env: NodeJS.ProcessEnv): Record<string, string | null> {
  return Object.fromEntries(CONTEXT_ENV_KEYS.map((key) => [key, env[key] ?? null]))
}

function jobEnvironment(worker: NodeJS.ProcessEnv, snapshot?: QueueJob['env']): NodeJS.ProcessEnv {
  const env = { ...worker }
  if (!snapshot) return env // v1 jobs predate environment snapshots
  for (const key of CONTEXT_ENV_KEYS) delete env[key]
  for (const key of CONTEXT_ENV_KEYS) {
    const value = snapshot[key]
    if (typeof value === 'string') env[key] = value
  }
  return env
}

const queueMutations = new Map<string, Promise<void>>()

async function mutateQueue<T>(workspace: string, action: () => Promise<T>): Promise<T> {
  // Serialize local callers before competing for the cross-process lock. A
  // burst of hooks must not spend its entire lock budget fighting itself.
  const previous = queueMutations.get(workspace) ?? Promise.resolve()
  const result = previous.then(() => withQueueLock(workspace, action))
  const settled = result.then(() => undefined, () => undefined)
  queueMutations.set(workspace, settled)
  try {
    return await result
  } finally {
    if (queueMutations.get(workspace) === settled) queueMutations.delete(workspace)
  }
}

async function withQueueLock<T>(workspace: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 1_000
  let release: (() => Promise<void>) | undefined
  while (!release) {
    try {
      release = await acquireDirectoryLock(join(uploadRoot(workspace), 'jobs-mutation.lock'))
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'upload worker is already running') throw error
      if (Date.now() >= deadline) throw new UploadError('queue_busy', 'queue mutation lock busy', true)
      await sleep(20)
    }
  }
  try {
    return await action()
  } finally {
    await release()
  }
}

export function validateNotification(value: unknown, workspace?: string): RecordCommittedNotification {
  const root = object(value)
  if (!root) throw new Error('record-committed notification invalid')
  const version = root.schemaVersion
  const base = ['event', 'provider', 'recordId', 'schemaVersion', 'sequence', 'sessionId', 'workspace']
  const v2 = ['recordPath', 'sha256']
  const keys = Object.keys(root).sort()
  const allowed = new Set([...base, ...v2])
  if (
    base.some((key) => !(key in root)) ||
    keys.some((key) => !allowed.has(key)) ||
    root.event !== 'record-committed' ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  )
    throw new Error('record-committed 通知格式无效')
  if (workspace !== undefined && root.workspace !== workspace)
    throw new Error('record-committed workspace 不匹配')
  if (typeof root.workspace !== 'string' || !isAbsolute(root.workspace))
    throw new Error('record-committed workspace invalid')
  if (!PROVIDERS.includes(root.provider as (typeof PROVIDERS)[number]))
    throw new Error('record-committed provider invalid')
  if (typeof root.sessionId !== 'string' || !ID_RE.test(root.sessionId))
    throw new Error('record-committed sessionId invalid')
  if (typeof root.recordId !== 'string' || !RECORD_ID_RE.test(root.recordId))
    throw new Error('record-committed recordId invalid')
  if (!Number.isSafeInteger(root.sequence) || Number(root.sequence) < 1)
    throw new Error('record-committed sequence invalid')
  if (
    ('recordPath' in root &&
      root.recordPath !== `records/${String(root.sequence).padStart(20, '0')}-${root.recordId}.json`) ||
    ('sha256' in root && (typeof root.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(root.sha256)))
  )
    throw new Error('record-committed v2 custody fields invalid')
  return root as unknown as RecordCommittedNotification
}

async function persistJob(workspace: string, job: QueueJob): Promise<void> {
  await prepareUploadRoot(workspace)
  await writeJsonAtomic(join(queuePath(workspace), `${job.id}.json`), job)
}
function spawnWorker(workspace: string, env: NodeJS.ProcessEnv): void {
  if (env.SCRY_UPLOADER_NO_SPAWN === '1') return
  const child = spawn(process.execPath, [uploaderEntrypoint(), '_worker', '--workspace', workspace], {
    cwd: workspace,
    env,
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

export async function notifyRecordCommit(
  workspace: string,
  notification: RecordCommittedNotification,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const receipt = await takeCustody(workspace, notification, env.SCRY_TURN_UPLOAD_ENABLED === '0')
  if (
    receipt.status === 'skipped_disabled' ||
    receipt.status === 'uploaded' ||
    receipt.status === 'dead_letter' ||
    receipt.wakeupQueuedAt
  )
    return `record-${String(notification.sequence).padStart(20, '0')}-${notification.recordId}`
  const id = await enqueueRecordCommit(workspace, notification, env)
  await markWakeupQueued(workspace, notification.sequence, notification.recordId)
  return id
}

export async function enqueueRecordCommit(
  workspace: string,
  notification: RecordCommittedNotification,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  await prepareUploadRoot(workspace)
  const id = `record-${String(notification.sequence).padStart(20, '0')}-${notification.recordId}`
  const path = join(queuePath(workspace), `${id}.json`)
  await mutateQueue(workspace, async () => {
    const existing = await readJob(workspace, path)
    if (existing) {
      if (
        existing.expectedSequence !== notification.sequence ||
        existing.recordId !== notification.recordId
      ) {
        throw new Error('record-committed queue identity conflict')
      }
      return
    }
    await persistJob(workspace, {
      version: 1,
      id,
      kind: 'record-commit',
      workspace,
      createdAt: now(),
      attempts: 0,
      maxAttempts: JOB_MAX_ATTEMPTS,
      notBeforeMs: Date.now(),
      expectedSequence: notification.sequence,
      recordId: notification.recordId,
      provider: notification.provider,
      sessionId: notification.sessionId,
      env: capturedEnv(env)
    })
  })
  spawnWorker(workspace, env)
  return id
}

export async function enqueueWakeup(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  onlyIfMissing = false
): Promise<string> {
  await prepareUploadRoot(workspace)
  // Persist current denial before handing control to an asynchronous worker.
  if (env.SCRY_TURN_UPLOAD_ENABLED === '0') await setUploadPolicy(workspace, false, env)
  const trigger = env.SCRY_UPLOAD_TRIGGER
  const precise = trigger === 'completion' || trigger === 'record-commit'
  const identity = [
    trigger,
    env.SCRY_PROVIDER_ID,
    env.SCRY_UPLOAD_SESSION_ID,
    env.SCRY_UPLOAD_EXPECTED_SEQUENCE,
    env.SCRY_UPLOAD_RECORD_ID ?? env.SCRY_UPLOAD_EXPECTED_RECORD_ID
  ]
  const id = precise
    ? `wakeup-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
    : 'wakeup-recovery'
  const path = join(queuePath(workspace), `${id}.json`)
  await mutateQueue(workspace, async () => {
    const existing = await readJob(workspace, path)
    if (!existing) {
      await persistJob(workspace, {
        version: 1,
        id,
        kind: 'wakeup',
        workspace,
        createdAt: now(),
        attempts: 0,
        maxAttempts: JOB_MAX_ATTEMPTS,
        notBeforeMs: Date.now(),
        env: capturedEnv(env),
        generation: 1
      })
    } else if (!onlyIfMissing) {
      await writeJsonAtomic(path, {
        ...existing,
        notBeforeMs: Date.now(),
        env: capturedEnv(env),
        generation: (existing.generation ?? 0) + 1
      })
    }
  })
  spawnWorker(workspace, env)
  return id
}

async function jobPaths(workspace: string): Promise<string[]> {
  return (await readdir(queuePath(workspace)))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(queuePath(workspace), name))
}
function validJob(job: QueueJob | null, workspace: string): job is QueueJob {
  return (
    !!job &&
    job.version === 1 &&
    job.workspace === workspace &&
    (job.kind === 'record-commit' || job.kind === 'wakeup') &&
    typeof job.id === 'string' &&
    ID_RE.test(job.id) &&
    Number.isSafeInteger(job.attempts) &&
    job.attempts >= 0 &&
    Number.isSafeInteger(job.notBeforeMs) &&
    job.notBeforeMs >= 0 &&
    (job.maxAttempts === undefined || job.maxAttempts === JOB_MAX_ATTEMPTS) &&
    (job.generation === undefined || (Number.isSafeInteger(job.generation) && job.generation >= 0)) &&
    (job.rerunRequested === undefined || typeof job.rerunRequested === 'boolean') &&
    (job.env === undefined ||
      (!!object(job.env) &&
        Object.entries(job.env).every(
          ([key, value]) => ENV_KEYS.includes(key) && (value === null || typeof value === 'string')
        ))) &&
    (job.kind !== 'record-commit' ||
      (Number.isSafeInteger(job.expectedSequence) &&
        Number(job.expectedSequence) > 0 &&
        typeof job.recordId === 'string' &&
        RECORD_ID_RE.test(job.recordId)))
  )
}
// Called under the queue mutation lock: preserve corrupt job bytes rather than
// overwriting them with a synthetic successful handoff.
async function readJob(workspace: string, path: string): Promise<QueueJob | null> {
  let job: QueueJob | null = null
  try {
    job = await readJson<QueueJob>(path)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  if (validJob(job, workspace) && basename(path) === `${job.id}.json`) return job
  if (await exists(path)) {
    const target = join(queuePath(workspace), 'dead-letter', `invalid-${randomUUID()}-${basename(path)}`)
    await rename(path, target)
    await syncDirectory(dirname(target))
    await syncDirectory(dirname(path))
  }
  return null
}

async function deadLetterJob(workspace: string, path: string, job: QueueJob, reason: string): Promise<void> {
  const target = join(queuePath(workspace), 'dead-letter', `${Date.now()}-${job.id}.json`)
  await writeJsonAtomic(path, { ...job, lastError: reason, deadAt: now() })
  await rename(path, target)
}

type JobOutcome = {
  kind: 'success' | 'dead' | 'abandon' | 'retry'
  retryAtMs?: number
}
async function executeJob(
  workspace: string,
  path: string,
  job: QueueJob,
  env: NodeJS.ProcessEnv
): Promise<JobOutcome> {
  if (!(await exists(join(workspace, 'scry.config.json')))) return { kind: 'abandon' }
  await mutateQueue(workspace, async () => {
    const current = await readJson<QueueJob>(path)
    if (!current) throw new Error('queued job disappeared')
    job = current
    job.lastAttemptAt = now()
    delete job.lastError
    await writeJsonAtomic(path, job)
  })
  let failure: unknown
  try {
    if (job.attempts >= JOB_MAX_ATTEMPTS)
      throw new UploadError('job_attempts_exhausted', 'job retry budget exhausted')
    const result = await runUpload(workspace, {
      env: jobEnvironment(env, job.env),
      legacyUploadDisabled: job.env?.SCRY_TURN_UPLOAD_ENABLED === '0',
      mode: job.kind === 'record-commit' ? 'record-commit' : 'wakeup',
      ...(job.kind === 'record-commit' && job.expectedSequence && job.recordId
        ? {
            expected: {
              sequence: job.expectedSequence,
              recordId: job.recordId,
              provider: job.provider,
              sessionId: job.sessionId
            }
          }
        : {})
    })
    if (result.deferredUntilMs !== undefined) {
      const deferred = new UploadError(
        'upload_deferred',
        'upload progress completed; remaining work is deferred',
        true,
        result.deferredUntilMs
      )
      deferred.deferJobAttempt = true
      deferred.deferred = true
      throw deferred
    }
  } catch (error) {
    failure = error
  }
  if (!(await exists(join(workspace, 'scry.config.json')))) return { kind: 'abandon' }
  return await mutateQueue(workspace, async () => {
    const current = await readJson<QueueJob>(path)
    if (!current) throw new Error('queued job disappeared')
    if ((current.generation ?? 0) !== (job.generation ?? 0) || current.rerunRequested) {
      // A newer wakeup owns this path. Never erase or overwrite its environment
      // with the just-finished invocation's stale snapshot.
      current.rerunRequested = false
      current.attempts = 0
      current.notBeforeMs = Date.now()
      await writeJsonAtomic(path, current)
      return { kind: 'success' }
    }
    if (failure === undefined) {
      await unlink(path)
      return { kind: 'success' }
    }
    const reason = safeReason(failure)
    const retryable = failure instanceof UploadError ? failure.retryable : true
    if (!retryable) {
      await deadLetterJob(workspace, path, job, reason)
      return { kind: 'dead' }
    }
    const deferAttempt = failure instanceof UploadError && failure.deferJobAttempt === true
    if (!deferAttempt) job.attempts++
    if (!deferAttempt && job.attempts >= JOB_MAX_ATTEMPTS) {
      await deadLetterJob(workspace, path, job, reason)
      return { kind: 'dead' }
    }
    job.lastError = reason
    job.notBeforeMs =
      failure instanceof UploadError && failure.retryAtMs
        ? Math.max(Date.now() + 100, failure.retryAtMs)
        : Date.now() + backoff(Math.max(1, job.attempts))
    await writeJsonAtomic(path, job)
    return { kind: 'retry', retryAtMs: job.notBeforeMs }
  })
}

async function acquireWorkerLock(workspace: string): Promise<() => Promise<void>> {
  // Hooks are edge-triggered. A losing detached worker must exit instead of
  // becoming a long-lived sleeper for every hook invocation.
  return await acquireDirectoryLock(join(uploadRoot(workspace), 'standalone-queue.lock'))
}

export async function runQueueWorker(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { once?: boolean } = {}
): Promise<void> {
  if (!(await exists(join(workspace, 'scry.config.json')))) return
  await prepareUploadRoot(workspace)
  let release: (() => Promise<void>) | undefined
  try {
    release = await acquireWorkerLock(workspace)
  } catch (error) {
    if (error instanceof Error && error.message === 'upload worker is already running') return
    throw error
  }
  try {
    while (true) {
      if (!(await exists(join(workspace, 'scry.config.json')))) return
      let hadJobs = false
      let executed = false
      let earliest: number | undefined
      let workspaceGone = false
      const paths = await jobPaths(workspace)
      hadJobs = paths.length > 0
      for (const path of paths) {
        const job = await mutateQueue(workspace, () => readJob(workspace, path))
        if (!job) continue
        if (job.notBeforeMs > Date.now()) {
          earliest = earliest === undefined ? job.notBeforeMs : Math.min(earliest, job.notBeforeMs)
          continue
        }
        const outcome = await executeJob(workspace, path, job, env)
        executed = true
        if (outcome.kind === 'abandon') {
          workspaceGone = true
          break
        }
        if (options.once) break
      }
      if (workspaceGone || options.once) return
      if (!hadJobs) {
        // Lost-wakeup handshake: relinquish ownership, then recheck before
        // deciding that this edge-triggered worker is done.
        await release()
        release = undefined
        if ((await jobPaths(workspace)).length === 0) return
        release = await acquireWorkerLock(workspace).catch((error) => {
          if (error instanceof Error && error.message === 'upload worker is already running') return undefined
          throw error
        })
        if (!release) return
        continue
      }
      if (!executed && earliest !== undefined) await sleep(Math.max(100, Math.min(1_000, earliest - Date.now())))
      else if (executed && (await jobPaths(workspace)).length) await sleep(100)
      else if (executed) {
        await release()
        release = undefined
        if ((await jobPaths(workspace)).length === 0) return
        release = await acquireWorkerLock(workspace).catch((error) => {
          if (error instanceof Error && error.message === 'upload worker is already running') return undefined
          throw error
        })
        if (!release) return
      }
    }
  } finally {
    if (release) await release()
  }
}
