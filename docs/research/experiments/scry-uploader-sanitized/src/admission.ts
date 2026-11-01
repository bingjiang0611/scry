import { homedir } from 'node:os'
import { join } from 'node:path'
import { UploadError } from './errors.js'
import { acquireDirectoryLock, ensurePrivateDirectory, readJson, sleep, writeJsonAtomic } from './util.js'

function admissionRoot(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'scry-upload', 'admission')
}

export async function admissionRetryAt(env: NodeJS.ProcessEnv): Promise<number | undefined> {
  const state = await readJson<{ notBeforeMs: number }>(join(admissionRoot(env), 'retry-after.json'))
  if (state && (!Number.isSafeInteger(state.notBeforeMs) || state.notBeforeMs < 0))
    throw new UploadError('invalid_admission_state', 'user upload cooldown is invalid')
  return state && state.notBeforeMs > Date.now() ? state.notBeforeMs : undefined
}

export async function deferUploadAdmission(env: NodeJS.ProcessEnv, notBeforeMs: number): Promise<void> {
  const root = admissionRoot(env)
  await ensurePrivateDirectory(root)
  const deadline = Date.now() + 1_000
  let release: (() => Promise<void>) | undefined
  while (!release) {
    try {
      release = await acquireDirectoryLock(join(root, 'retry-after.lock'))
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'upload worker is already running') throw error
      if (Date.now() >= deadline) throw new UploadError('admission_state_busy', 'user cooldown update is busy', true)
      await sleep(20)
    }
  }
  try {
    await writeJsonAtomic(join(root, 'retry-after.json'), {
      notBeforeMs: Math.max(notBeforeMs, (await admissionRetryAt(env)) ?? 0)
    })
  } finally {
    await release()
  }
}

export async function acquireUploadAdmission(
  env: NodeJS.ProcessEnv,
  deadline: number,
  // A queued wakeup must not park a process behind a long upload while every
  // slot is busy: the job is durable, so give up quickly and let the queue
  // reschedule. Waiting forever is what piles up worker processes.
  waitBudgetMs = Number.POSITIVE_INFINITY
): Promise<() => Promise<void>> {
  const root = admissionRoot(env)
  await ensurePrivateDirectory(root)
  if (Date.now() >= deadline)
    throw new UploadError('upload_deadline_exhausted', 'upload deadline exhausted', true)
  // Every attempt spawns a kernel lock helper per slot. Polling at a fixed
  // 100ms spends hundreds of processes on a busy user, so widen the interval
  // with jitter as the wait grows.
  const stopAt = Math.min(deadline, Date.now() + waitBudgetMs)
  let wait = 200
  while (Date.now() < deadline) {
    const retryAt = await admissionRetryAt(env)
    if (retryAt) {
      const deferred = new UploadError('transport_cooldown', 'server requested an upload cooldown', true, retryAt)
      deferred.deferred = true
      deferred.deferJobAttempt = true
      throw deferred
    }
    for (const index of [0, 1]) {
      try {
        return await acquireDirectoryLock(join(root, `slot-${index}`))
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'upload worker is already running') throw error
      }
    }
    if (Date.now() >= stopAt) break
    const jittered = Math.floor(wait * (0.8 + Math.random() * 0.4))
    await sleep(Math.min(jittered, Math.max(1, stopAt - Date.now())))
    wait = Math.min(500, Math.floor(wait * 1.6))
  }
  if (Date.now() < deadline && Date.now() >= stopAt) {
    const deferred = new UploadError(
      'upload_admission_busy',
      'user upload concurrency limit reached',
      true,
      Date.now() + 250 + Math.floor(Math.random() * 750)
    )
    deferred.deferred = true
    deferred.deferJobAttempt = true
    throw deferred
  }
  throw new UploadError('upload_admission_busy', 'user upload concurrency limit reached', true)
}
