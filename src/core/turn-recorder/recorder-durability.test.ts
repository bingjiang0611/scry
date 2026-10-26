import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { recorderSessionRoot } from './runtime-state'

const synced = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync()
        synced.push(String(args[0]))
      }
      return handle
    }
  }
})

const roots: string[] = []
afterEach(async () => {
  synced.length = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([
  { event: 'Stop', managed: false },
  { event: 'SessionEnd', managed: false },
  { event: 'Stop', managed: true }
])('fsync start and closing boundaries ($event, managed=$managed), not intermediate hooks', async ({ event, managed }) => {
  const root = await mkdtemp(join(tmpdir(), 'scry-durability-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'durability', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  const session = recorderSessionRoot(join(root, '.scry'), 'claude', 'durable-session')
  const base = { provider: 'claude' as const, workspace: root, managed, env: {},
    payload: { session_id: 'durable-session', turn_id: 'turn-1', timestamp: '2026-07-19T12:00:00.000Z' } }
  const take = () => synced.splice(0)
  take()
  await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: { ...base.payload, prompt: 'go' } })
  const start = take()
  await handleRecorderHook({ ...base, event: 'PreToolUse', payload: { ...base.payload, tool_name: 'Read', tool_input: { file_path: 'a.txt' } } })
  const intermediate = take()
  await handleRecorderHook({ ...base, event, payload: { ...base.payload, timestamp: '2026-07-19T12:00:01.000Z' } })
  const closing = take()
  expect(JSON.parse(await readFile(join(session, 'open.json'), 'utf8')).status).toBe('closing')
  if (!managed) await recoverRecorder(root, {})
  const recovery = take()
  console.info('SCRY_DURABILITY_L1', JSON.stringify({ event, managed,
    start: start.length, intermediate: intermediate.length, closing: closing.length, recovery: recovery.length,
    total: start.length + intermediate.length + closing.length + recovery.length }))
  const fileSyncs = (calls: string[], file: string) => calls.filter(path => path.startsWith(join(session, `${file}.`)) && path.endsWith('.tmp'))
  expect.soft(fileSyncs(start, 'open.json')).toHaveLength(1)
  expect.soft(fileSyncs(start, 'session.json')).toHaveLength(1)
  expect.soft(start.filter(path => path === session)).toHaveLength(2)
  expect.soft(fileSyncs(intermediate, 'open.json')).toHaveLength(0)
  expect.soft(fileSyncs(closing, 'open.json')).toHaveLength(1)
  expect.soft(closing.filter(path => path === session)).toHaveLength(1)
})
