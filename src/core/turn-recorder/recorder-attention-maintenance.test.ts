import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { markedSessions, withSessionAttentionLock } from './attention'
import { resolveRecorderEnablement } from './config'
import { recorderInboxEntries } from './inbox'
import { readJson, writeJsonAtomic } from './io'
import { queueHook } from './recorder-hook-queue'
import { reconcileAttentionIndex, recorderTurnRoot } from './runtime-state'
import { listRecords, safeKey } from './store'

const fault = vi.hoisted(() => ({ directory: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === fault.directory) throw Object.assign(new Error('provider directory unavailable'), { code: 'EIO' })
      return actual.readdir(...args)
    }
  }
})

const roots: string[] = []
beforeEach(() => { vi.resetModules() })
afterEach(async () => {
  fault.directory = ''
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-attention-maintenance-'))
  roots.push(root)
  const env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
  vi.stubEnv('HOME', env.HOME)
  vi.stubEnv('XDG_STATE_HOME', env.XDG_STATE_HOME)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'maintenance', dataDir: '.scry',
    repositories: { mode: 'workspace-only' }, capture: { diff: false }
  }))
  const enabled = await resolveRecorderEnablement(root, env)
  if (!enabled.enabled) throw new Error('fixture recorder disabled')
  const recorder = await import('./recorder')
  const sessionId = 'maintenance-session'
  const sessionDir = join(enabled.dataRoot, 'runtime', 'claude', safeKey(sessionId))
  const hook = (event: string) => recorder.handleRecorderHook({ provider: 'claude', event,
    workspace: root, env, deferDelivery: true, payload: { session_id: sessionId, prompt: 'durable turn' } })
  return { root, env, enabled, sessionId, sessionDir, hook, recorder }
}

it('acknowledges a committed turn and removes runtime files even when attention cleanup times out', async () => {
  const f = await fixture()
  await f.hook('UserPromptSubmit')
  const open = await readJson<{ generation: number }>(join(f.sessionDir, 'open.json'))
  if (!open) throw new Error('missing fixture turn')
  let held!: () => void, release!: () => void
  const acquired = new Promise<void>(resolve => { held = resolve })
  const resumed = new Promise<void>(resolve => { release = resolve })
  const holder = withSessionAttentionLock(f.enabled.dataRoot, 'claude', safeKey(f.sessionId), async () => {
    held()
    await resumed
  })
  try {
    await acquired
    // Uses the production two-second timeout, not a mocked error or an extended test timeout.
    expect((await f.hook('Stop')).status).toBe('committed')
    expect(await listRecords(f.enabled.dataRoot)).toHaveLength(1)
    await expect(readFile(join(f.sessionDir, 'open.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(recorderTurnRoot(f.sessionDir, open.generation))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.enabled.dataRoot, 'logs', 'recorder.log'), 'utf8')).toMatch(/WARN attention cleanup:.*lock timeout/)
    expect((await readJson<{ droppedEvents: number }>(join(f.enabled.dataRoot, 'health.json')))?.droppedEvents).toBe(0)
  } finally {
    release()
    await holder
  }
  await f.recorder.recoverRecorder(f.root, f.env)
  expect(await markedSessions(f.enabled.dataRoot)).toHaveLength(0)
})

it('clears current-generation quarantine evidence before deciding whether to keep the marker', async () => {
  const f = await fixture()
  await f.hook('UserPromptSubmit')
  const open = await readJson<{ generation: number }>(join(f.sessionDir, 'open.json'))
  if (!open) throw new Error('missing fixture turn')
  const turn = recorderTurnRoot(f.sessionDir, open.generation)
  await writeJsonAtomic(join(turn, 'pending-open.json'), open)
  expect((await f.hook('Stop')).status).toBe('committed')
  expect(await markedSessions(f.enabled.dataRoot)).toHaveLength(0)
  await expect(readFile(join(turn, 'pending-open.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps recovering known inbox work when a periodic rebuild fails, without fabricating dropped events', async () => {
  const f = await fixture()
  await reconcileAttentionIndex(f.enabled.dataRoot)
  for (let pass = 1; pass < 64; pass++) await f.recorder.recoverRecorder(f.root, f.env)
  await queueHook(f.enabled, { provider: 'claude', event: 'UserPromptSubmit', workspace: f.root,
    payload: { session_id: f.sessionId, prompt: 'known queued work' } }, f.sessionId, new Date().toISOString())
  fault.directory = join(f.enabled.dataRoot, 'runtime', 'codex')
  await f.recorder.recoverRecorder(f.root, f.env)
  expect(await recorderInboxEntries(f.sessionDir)).toHaveLength(0)
  expect((await readJson<{ prompt: string }>(join(f.sessionDir, 'open.json')))?.prompt).toBe('known queued work')
  expect(await readFile(join(f.enabled.dataRoot, 'logs', 'recorder.log'), 'utf8')).toMatch(/WARN attention rebuild:.*provider directory unavailable/)
  expect((await readJson<{ droppedEvents: number }>(join(f.enabled.dataRoot, 'health.json')))?.droppedEvents ?? 0).toBe(0)
})
