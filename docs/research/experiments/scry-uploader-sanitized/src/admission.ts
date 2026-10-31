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
  deadline: number
): Promise<() => Promise<void>> {
  const root = admissionRoot(env)
  await ensurePrivateDirectory(root)
  if (Date.now() >= deadline)
    throw new UploadError('upload_deadline_exhausted', 'upload deadline exhausted', true)
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
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())))
  }
  throw new UploadError('upload_admission_busy', 'user upload concurrency limit reached', true)
}
