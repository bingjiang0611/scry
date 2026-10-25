import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { listRecords, readHealth } from './store'
import { recorderSessionRoot } from './runtime-state'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-terminal-replay-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'terminal-replay', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: false, hooks: true }
  }))
  return root
}

it.each([
  { event: 'SessionEnd', fields: { reason: 'exit' } },
  { event: 'Stop', fields: { stop_hook_active: true, last_assistant_message: 'OK' } }
])('V1 real Claude $event without timestamp after a committed turn is not missing_start', async ({ event, fields }) => {
  const root = await workspace()
  const dataRoot = join(root, '.scry')
  const base = { provider: 'claude' as const, workspace: root, env: {} }
  const common = { session_id: 'real-claude', cwd: root, permission_mode: 'default', transcript_path: join(root, 'session.jsonl') }
  await writeFile(common.transcript_path, [
    { type: 'user', timestamp: '2026-10-24T12:00:00Z', message: { role: 'user', content: 'Say OK' } },
    { type: 'assistant', timestamp: '2026-10-24T12:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } }
  ].map(row => JSON.stringify(row)).join('\n'))
  // Advance only Date, not timers or I/O: a real turn need not fit the stale-terminal grace window.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))
  await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'Say OK' } })
  vi.setSystemTime(new Date('2026-10-24T12:01:00Z'))
  await handleRecorderHook({ ...base, event: 'Stop', payload: { ...common, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'OK' } })
  await recoverRecorder(root, {})
  expect(await listRecords(dataRoot)).toHaveLength(1)
  const before = await readHealth(dataRoot)
  await expect(handleRecorderHook({ ...base, event, payload: { ...common, hook_event_name: event, ...fields } }))
    .resolves.toMatchObject({ status: 'duplicate' })
  const after = await readHealth(dataRoot)
  expect(after).toMatchObject({ missingStartTerminals: 0, orphanEvents: 0 })
  expect(after.lastError).toEqual(before.lastError)
  expect(await listRecords(dataRoot)).toHaveLength(1)
  await expect(readdir(join(recorderSessionRoot(dataRoot, 'claude', common.session_id), 'orphans')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['SessionEnd', 'session.end', 'session_end', 'session.exited', 'process.exit'])(
  'V1 %s without any open turn is session shutdown, not evidence of a missing start', async (event) => {
    const root = await workspace()
    expect(await handleRecorderHook({ provider: 'claude', workspace: root, event, env: {},
      payload: { session_id: 'between-turns', hook_event_name: event, reason: 'exit' }
    })).toMatchObject({ status: 'duplicate' })
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 0, missingStartTerminals: 0 })
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)
  }
)

it.each(['claude', 'codex', 'qoder'] as const)('V1 %s declares stop_hook_active as same-turn continuation', async (provider) => {
  const root = await workspace()
  const input = { provider, workspace: root, event: 'Stop', env: {}, payload: {
    session_id: 'continued', hook_event_name: 'Stop', cwd: root,
    transcript_path: join(root, 'session.jsonl'), stop_hook_active: true,
    ...(provider === 'codex' ? { turn_id: 'turn-1', model: 'gpt-5', permission_mode: 'default' } : {})
  } }
  expect(await handleRecorderHook(input)).toMatchObject({ status: 'duplicate' })
  expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 0, missingStartTerminals: 0 })
  // The exemption is only for absent open turns, never a reason to leave a real turn open.
  await handleRecorderHook({ ...input, event: 'UserPromptSubmit', payload: {
    session_id: 'continued', hook_event_name: 'UserPromptSubmit', prompt: 'go', timestamp: '2026-10-24T12:00:00Z'
  } })
  await handleRecorderHook({ ...input, payload: { session_id: 'continued', stop_hook_active: true, timestamp: '2026-10-24T12:01:00Z' } })
  await recoverRecorder(root, {})
  expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
})

it.each(['claude', 'codex', 'qoder', 'opencode'] as const)('V1 genuine missing-start %s Stop without timestamp still leaves an orphan', async (provider) => {
  const root = await workspace()
  expect(await handleRecorderHook({ provider, workspace: root, event: 'Stop', env: {}, payload: {
    session_id: 'missing', hook_event_name: 'Stop', cwd: root,
    ...(provider === 'opencode' ? { assistant_response: 'OK' } : { transcript_path: join(root, 'session.jsonl'), stop_hook_active: false })
  } })).toMatchObject({ status: 'orphan' })
  expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 1, missingStartTerminals: 1 })
})

it.each(['opencode', 'pi'] as const)('V1 does not invent stop_hook_active semantics for %s', async (provider) => {
  const root = await workspace()
  expect(await handleRecorderHook({ provider, workspace: root, event: 'Stop', env: {},
    payload: { session_id: 'unknown-signal', stop_hook_active: true }
  })).toMatchObject({ status: 'orphan' })
})

it.each([
  { startedAt: '2026-10-24T20:00:00+08:00', completedAt: '2026-10-24T20:01:00+08:00', terminalAt: '2026-10-24T12:00:30Z', expected: 'duplicate' },
  { startedAt: '2026-10-24T12:00:00Z', completedAt: '2026-10-24T12:01:00Z', terminalAt: '2026-10-24T12:01:00.500Z', expected: 'orphan' }
])('V1 compares instant values across timestamp formats ($expected)', async ({ startedAt, completedAt, terminalAt, expected }) => {
  const root = await workspace()
  const base = { provider: 'claude' as const, workspace: root, env: {} }
  await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: { session_id: 'formats', prompt: 'go', timestamp: '2026-10-24T12:00:00Z' } })
  await handleRecorderHook({ ...base, event: 'Stop', payload: { session_id: 'formats', timestamp: '2026-10-24T12:01:00Z' } })
  await recoverRecorder(root, {})
  const recordsRoot = join(root, '.scry/records')
  const [file] = await readdir(recordsRoot)
  const record = JSON.parse(await readFile(join(recordsRoot, file), 'utf8'))
  // The record contract accepts ISO offsets and precision variants. Keep the same instants,
  // identity and duration; this is a stored-record fixture, not a changed production parser.
  await writeFile(join(recordsRoot, file), JSON.stringify({ ...record, startedAt, completedAt }))
  expect(await handleRecorderHook({ ...base, event: 'Stop', payload: { session_id: 'formats', timestamp: terminalAt } }))
    .toMatchObject({ status: expected })
  expect(await readHealth(join(root, '.scry'))).toMatchObject({ missingStartTerminals: expected === 'orphan' ? 1 : 0 })
})
