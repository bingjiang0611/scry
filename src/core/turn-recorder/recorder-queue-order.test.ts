import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { recorderInboxEntries } from './inbox'
import { listRecords, safeKey } from './store'

// Deliberately reverse UUID lexical order: randomness must not decide lifecycle order.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  let sequence = 999999999999
  return { ...actual, randomUUID: () => `ffffffff-ffff-4fff-8fff-${sequence--}` }
})

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('replays same-millisecond queued hooks in arrival order, not UUID order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-queue-order-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'queue-order', capture: { diff: false }
  }))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-14T00:00:00Z'))
  const env = { HOME: root, PATH: process.env.PATH }
  for (const event of ['UserPromptSubmit', 'Stop']) {
    await expect(handleRecorderHook({ workspace: root, provider: 'pi', event, queueOnly: true,
      payload: { session_id: 'queued', prompt: 'fixture', assistant_response: 'done' }, env
    })).resolves.toMatchObject({ status: 'pending' })
  }
  const entries = await recorderInboxEntries(join(root, '.scry/runtime/pi', safeKey('queued')))
  const hooks = await Promise.all(entries.map(async entry => JSON.parse(await readFile(entry.path, 'utf8'))))
  expect(hooks.map(hook => hook.arrivedAt)).toEqual(['2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z'])
  expect(hooks.map(hook => hook.event)).toEqual(['UserPromptSubmit', 'Stop'])
  await recoverRecorder(root, env)
  expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
})
