import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveRecorderEnablement } from './config'
import { markedSessions } from './attention'
import { readJson } from './io'
import { recorderInboxEntries } from './inbox'
import { queueHook } from './recorder-hook-queue'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { reconcileAttentionIndex, recorderHasOpenTurn, recorderPendingHealth, releaseStaleAttention } from './runtime-state'
import { safeKey } from './store'

const schedule = vi.hoisted(() => ({
  writePrefix: '',
  marker: '',
  lock: '',
  cleaning: false,
  paused: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
  cleanupReady: undefined as (() => void) | undefined
}))

vi.mock('./io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./io')>()
  return {
    ...actual,
    async writeJsonAtomic(...args: Parameters<typeof actual.writeJsonAtomic>) {
      if (schedule.writePrefix && args[0].startsWith(schedule.writePrefix)) {
        schedule.paused?.()
        await schedule.resume
      }
      return actual.writeJsonAtomic(...args)
    },
    async withDirectoryLock<T>(path: string, action: () => Promise<T>, options?: { waitMs?: number; ttlMs?: number }) {
      if (schedule.cleaning && path === schedule.lock) schedule.cleanupReady?.()
      return actual.withDirectoryLock(path, action, options)
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rm(...args: Parameters<typeof actual.rm>) {
      await actual.rm(...args)
      // The old implementation reaches unlink instead of waiting for the publication lock.
      if (schedule.cleaning && args[0] === schedule.marker) schedule.cleanupReady?.()
    }
  }
})

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const roots: string[] = []
afterEach(async () => {
  schedule.writePrefix = ''
  schedule.cleaning = false
  schedule.paused = schedule.cleanupReady = undefined
  schedule.resume = undefined
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([
  ['queue', 'recovery'],
  ['queue', 'rebuild'],
  ['queue', 'rebuild-before-session-directory'],
  ['queue', 'finalize'],
  ['open', 'rebuild']
] as const)('keeps %s publication discoverable across %s cleanup', async (publication, cleanup) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-attention-race-'))
  roots.push(root)
  const env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
  vi.stubEnv('HOME', env.HOME)
  vi.stubEnv('XDG_STATE_HOME', env.XDG_STATE_HOME)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'attention-race', dataDir: '.scry',
    repositories: { mode: 'workspace-only' }, capture: { diff: false }
  }))
  const enablement = await resolveRecorderEnablement(root, env)
  if (!enablement.enabled) throw new Error('fixture recorder is disabled')
  const sessionId = 'arriving-turn'
  const key = safeKey(sessionId)
  const sessionDir = join(enablement.dataRoot, 'runtime', 'claude', key)
  const hook = (event: string, prompt: string) => handleRecorderHook({
    provider: 'claude', event, workspace: root, env, deferDelivery: true,
    payload: { session_id: sessionId, prompt }
  })
  if (cleanup === 'finalize') await hook('UserPromptSubmit', 'previous turn')
  else if (cleanup !== 'rebuild-before-session-directory') await mkdir(sessionDir, { recursive: true })

  const paused = signal(), resume = signal(), cleanupReady = signal()
  schedule.writePrefix = join(sessionDir, publication === 'queue' ? 'inbox' : 'open.json')
  schedule.marker = join(enablement.dataRoot, 'runtime', 'attention', `claude__${key}`)
  schedule.lock = join(enablement.dataRoot, 'locks', 'attention', 'claude', `${key}.lock`)
  schedule.paused = paused.resolve
  schedule.resume = resume.promise
  schedule.cleanupReady = cleanupReady.resolve
  const publishing = publication === 'queue'
    ? queueHook(enablement, { provider: 'claude', event: 'UserPromptSubmit', workspace: root,
      payload: { session_id: sessionId, prompt: 'arriving turn' }, queueOnly: true }, sessionId, new Date().toISOString())
    : hook('UserPromptSubmit', 'arriving turn')
  let cleaning: Promise<unknown> | undefined
  try {
    await Promise.race([paused.promise, publishing.then(() => { throw new Error('publication did not pause') })])
    schedule.cleaning = true
    cleaning = cleanup === 'recovery'
      ? releaseStaleAttention(enablement.dataRoot, 'claude', sessionDir)
      : cleanup === 'finalize'
        ? hook('Stop', '')
        : reconcileAttentionIndex(enablement.dataRoot)
    await Promise.race([cleanupReady.promise, cleaning.then(() => { throw new Error('cleanup did not reach the boundary') })])
    resume.resolve()
    const [, cleanupResult] = await Promise.all([publishing, cleaning])
    const expected = [{ provider: 'claude', sessionKey: key, sessionDir }]
    if (cleanup === 'rebuild' || cleanup === 'rebuild-before-session-directory') {
      expect(cleanupResult).toEqual(expected)
    }
    expect(await markedSessions(enablement.dataRoot)).toEqual(expected)
    expect(await recorderHasOpenTurn(enablement.dataRoot)).toBe(true)
    // An active unmanaged open turn is work for the daemon, but is not pending-finalize health.
    expect((await recorderPendingHealth(enablement.dataRoot)).pendingCount).toBe(publication === 'queue' ? 1 : 0)
    if (publication === 'queue') {
      expect(await recorderInboxEntries(sessionDir)).toHaveLength(1)
      await recoverRecorder(root, env)
      expect(await recorderInboxEntries(sessionDir)).toHaveLength(0)
    }
    expect((await readJson<{ prompt: string }>(join(sessionDir, 'open.json')))?.prompt).toBe('arriving turn')
  } finally {
    resume.resolve()
    await Promise.allSettled([publishing, ...(cleaning ? [cleaning] : [])])
  }
})
