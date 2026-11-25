import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { recorderOpenPath, recorderSessionRoot } from './runtime-state'
import { listRecords } from './store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-qoder-stop-'))
  roots.push(root)
  const transcript = join(root, 'synthetic.jsonl')
  const dataRoot = join(root, '.scry')
  const sessionId = 'qoder-stop-fixture'
  const now = Date.now()
  const at = (offset: number) => new Date(now + offset).toISOString()
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'qoder-stop', dataDir: '.scry',
    repositories: { mode: 'workspace-only' }, capture: { diff: false, toolOutput: 'summary' }
  }))
  await writeFile(transcript, '')
  const row = (value: object) => appendFile(transcript, JSON.stringify({ sessionId, ...value }) + '\n')
  const user = (id: string, parentUuid: string | null, requestSetId?: string) => row({
    type: 'user', timestamp: at(-2_000), promptId: id, requestSetId, uuid: id, parentUuid,
    message: { role: 'user', content: `fixture question ${id}` }
  })
  const reply = (id: string, parentUuid = id, promptId?: string) => row({
    type: 'assistant', timestamp: at(-500), uuid: `${id}-reply`, parentUuid, promptId,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'fixture answer' }] }
  })
  const hook = (event: string, payload: object = {}) => handleRecorderHook({
    provider: 'qoder', event, workspace: root, deferDelivery: true,
    payload: { session_id: sessionId, transcript_path: transcript, ...payload }
  })
  const start = (id: string, withRequestSet = false) => hook('UserPromptSubmit', {
    ...(withRequestSet ? { request_set_id: id } : { promptId: id }), timestamp: at(-2_000), prompt: `fixture question ${id}`
  })
  const records = () => listRecords(dataRoot)
  const poll = () => recoverRecorder(root, {}, undefined, undefined, { incremental: true })
  const state = async () => JSON.parse(await readFile(recorderOpenPath(recorderSessionRoot(dataRoot, 'qoder', sessionId)), 'utf8'))
  const log = () => readFile(join(dataRoot, 'logs', 'recorder.log'), 'utf8')
  return { start, hook, row, user, reply, records, poll, state, log }
}

it('commits an anonymous short Qoder Stop when the exact prompt already has a final reply', async () => {
  const f = await fixture()
  await f.user('first', null)
  await f.start('first')
  await f.reply('first') // Qoder often has a parent UUID but no assistant promptId.
  expect(await f.hook('Stop')).toMatchObject({ status: 'committed' })
  expect(await f.records()).toMatchObject([{ providerTurnId: 'first', status: 'completed',
    termination: { value: { completedAtSource: 'provider_transcript' } } }])
})

it('does not accept an old anonymous Stop merely because it arrives after a new tool event', async () => {
  const f = await fixture()
  await f.start('old')
  await f.user('old', null)
  await f.reply('old')
  await f.user('next', 'old-reply')
  expect(await f.start('next')).toMatchObject({ status: 'started' })
  expect(await f.state()).toHaveProperty('providerTurnId', 'next')
  await f.hook('PostToolUse', { promptId: 'next', tool_name: 'Read', tool_use_id: 'read-next' })
  expect(await f.hook('Stop', { promptId: 'old' })).toMatchObject({ status: 'duplicate' })
  expect(await f.hook('Stop')).toMatchObject({ status: 'pending' })
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  expect(await f.records()).toMatchObject([{ providerTurnId: 'old', status: 'interrupted' }])
  await f.hook('PreToolUse', { promptId: 'next', tool_name: 'Read', tool_use_id: 'read-again' })
  expect(await f.state()).not.toHaveProperty('deferredTerminalAt')
  expect(await f.log()).toMatch(/reason=stale_terminal outcome=activity waitedMs=\d+/)
})

it('releases a deferred Stop at the next poll when the uniquely mapped final reply appears', async () => {
  const f = await fixture()
  // Not the Provider session's first turn, even though this is the first one seen by the recorder.
  await f.user('prior', null)
  await f.user('native', 'prior', 'mapped')
  await f.start('mapped', true)
  expect(await f.hook('Stop')).toMatchObject({ status: 'pending' })
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  expect(await f.records()).toHaveLength(0)
  await f.reply('native')
  expect(await f.poll()).toMatchObject({ recovered: 1 })
  expect(await f.records()).toMatchObject([{ providerTurnId: 'native', status: 'completed' }])
  const log = await f.log()
  expect(log).toContain('qoder_stop_hold reason=stale_terminal outcome=deferred waitedMs=')
  expect(log).toMatch(/qoder_stop_hold reason=stale_terminal outcome=transcript_evidence waitedMs=\d+/)
  expect(log).not.toMatch(/synthetic\.jsonl|fixture question|qoder-stop-fixture/)
})

it('waits exactly one poll for an anonymous Stop on a proven native root prompt', async () => {
  const f = await fixture()
  await f.user('first', null)
  await f.start('first')
  expect(await f.hook('Stop')).toMatchObject({ status: 'pending' })
  expect(await f.records()).toHaveLength(0)
  expect(await f.poll()).toMatchObject({ recovered: 1 })
  expect(await f.log()).toContain('reason=stale_terminal outcome=first_turn_poll')
})

it('keeps the separate background-task hold even when a native final reply is visible', async () => {
  const f = await fixture()
  await f.user('first', null)
  await f.start('first')
  await f.row({ type: 'user', parentUuid: 'first', uuid: 'launch', toolUseResult: { kind: 'async_launched', taskId: 'bg' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'running' }] } })
  await f.reply('first', 'launch', 'first')
  expect(await f.hook('Stop')).toMatchObject({ status: 'pending' })
  expect(await f.state()).toHaveProperty('deferredTerminalReason', 'pending_background_tasks')
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  expect(await f.records()).toHaveLength(0)
  expect(await f.log()).toContain('reason=pending_background_tasks outcome=deferred')
})

it('keeps a Stop with matching native ID on the direct path', async () => {
  const f = await fixture()
  await f.user('first', null)
  await f.start('first')
  expect(await f.hook('Stop', { promptId: 'first' })).toMatchObject({ status: 'committed' })
})
