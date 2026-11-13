import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { attentionIndexPresent, markSessionAttention } from './attention'
import { resolveRecorderEnablement } from './config'
import { readJson } from './io'
import { recorderInboxEntries } from './inbox'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { reconcileAttentionIndex, recorderPendingHealth } from './runtime-state'
import { safeKey } from './store'

const fault = vi.hoisted(() => ({ directory: '' }))
const attentionLocks = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args)
      if (String(args[0]).includes('/locks/attention/') && String(args[0]).endsWith('.lock')) {
        attentionLocks.push(String(args[0]))
      }
      return result
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === fault.directory) throw Object.assign(new Error('interrupted directory scan'), { code: 'EIO' })
      return actual.readdir(...args)
    }
  }
})

const roots: string[] = []
afterEach(async () => {
  fault.directory = ''
  attentionLocks.length = 0
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-attention-initialize-'))
  roots.push(root)
  const env = { HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state') }
  vi.stubEnv('HOME', env.HOME)
  vi.stubEnv('XDG_STATE_HOME', env.XDG_STATE_HOME)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'initialization', dataDir: '.scry',
    repositories: { mode: 'workspace-only' }, capture: { diff: false }
  }))
  const enabled = await resolveRecorderEnablement(root, env)
  if (!enabled.enabled) throw new Error('fixture recorder is disabled')
  const sessionId = 'legacy-session'
  const sessionDir = join(enabled.dataRoot, 'runtime', 'claude', safeKey(sessionId))
  const inbox = join(sessionDir, 'inbox')
  await mkdir(inbox, { recursive: true })
  await writeFile(join(inbox, '000000000000001-legacy.json'), JSON.stringify({
    schemaVersion: 1, provider: 'claude', sessionId, event: 'UserPromptSubmit',
    payload: { session_id: sessionId, prompt: 'legacy queued prompt' }, arrivedAt: new Date().toISOString()
  }))
  return { root, env, dataRoot: enabled.dataRoot, sessionDir }
}

it.each(['new hook', 'partial index'] as const)('discovers legacy work even when a %s created the index directory first', async (scenario) => {
  const f = await fixture()
  if (scenario === 'new hook') {
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: f.root,
      env: f.env, deferDelivery: true, payload: { session_id: 'new-session', prompt: 'new prompt' } })
  } else {
    await markSessionAttention(f.dataRoot, 'claude', safeKey('another-session'))
  }
  expect((await recorderPendingHealth(f.dataRoot)).pendingCount).toBe(1)
  await recoverRecorder(f.root, f.env)
  expect(await recorderInboxEntries(f.sessionDir)).toHaveLength(0)
  expect((await readJson<{ prompt: string }>(join(f.sessionDir, 'open.json')))?.prompt).toBe('legacy queued prompt')
  expect(await attentionIndexPresent(f.dataRoot)).toBe(true)
})

it('does not create locks for unmarked completed sessions during initialization', async () => {
  const f = await fixture()
  for (let index = 0; index < 50; index++) {
    await mkdir(join(f.dataRoot, 'runtime', 'claude', `finished-${index}`))
  }
  await reconcileAttentionIndex(f.dataRoot)
  expect(attentionLocks).toEqual([
    join(f.dataRoot, 'locks', 'attention', 'claude', `${safeKey('legacy-session')}.lock`)
  ])
  expect(await recorderInboxEntries(f.sessionDir)).toHaveLength(1)
  expect(await attentionIndexPresent(f.dataRoot)).toBe(true)
})

it('does not publish initialization after an interrupted full scan and rebuilds on the next recovery', async () => {
  const f = await fixture()
  fault.directory = join(f.dataRoot, 'runtime', 'codex')
  await expect(reconcileAttentionIndex(f.dataRoot)).rejects.toMatchObject({ code: 'EIO' })
  expect(await attentionIndexPresent(f.dataRoot)).toBe(false)
  expect(await recorderInboxEntries(f.sessionDir)).toHaveLength(1)

  fault.directory = ''
  await recoverRecorder(f.root, f.env)
  expect(await attentionIndexPresent(f.dataRoot)).toBe(true)
  expect(await recorderInboxEntries(f.sessionDir)).toHaveLength(0)
  expect((await readJson<{ prompt: string }>(join(f.sessionDir, 'open.json')))?.prompt).toBe('legacy queued prompt')
})
