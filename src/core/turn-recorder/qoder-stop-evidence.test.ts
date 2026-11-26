import { execFileSync } from 'node:child_process'
import { appendFile, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { handleRecorderHook, recoverRecorder } from './recorder'
import { QODER_STOP_TRANSCRIPT_WAIT_MS, qoderRequestStopAttribution, rememberQoderRequest } from './qoder-stop-evidence'
import { recorderOpenPath, recorderSessionRoot, recorderStatePath, recorderTurnRoot, type RecorderOpenTurnState, type RecorderSessionState } from './runtime-state'
import { listRecords } from './store'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(diff = false) {
  const root = await mkdtemp(join(tmpdir(), 'scry-qoder-stop-'))
  roots.push(root)
  const transcript = join(root, 'synthetic.jsonl')
  const dataRoot = join(root, '.scry')
  const sessionId = 'qoder-stop-fixture'
  const sessionRoot = recorderSessionRoot(dataRoot, 'qoder', sessionId)
  const now = Date.now()
  const at = (offset: number) => new Date(now + offset).toISOString()
  if (diff) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-q')
    await writeFile(join(root, 'example.txt'), 'before\n')
    git('add', 'example.txt')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'before')
  }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'qoder-stop', dataDir: '.scry',
    repositories: { mode: 'workspace-only' }, capture: { diff, toolOutput: diff ? 'full' : 'summary' }
  }))
  const row = (value: object) => appendFile(transcript, JSON.stringify({ sessionId, ...value }) + '\n')
  const user = (id: string, parentUuid: string | null, requestSetId?: string) => row({
    type: 'user', timestamp: at(-2_000), promptId: id, requestSetId, uuid: id, parentUuid,
    message: { role: 'user', content: `fixture question ${id}` }
  })
  const reply = (id: string, parentUuid = id) => row({
    type: 'assistant', timestamp: at(-500), uuid: `${id}-reply`, parentUuid,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'same reply' }] }
  })
  const hook = (event: string, payload: object = {}) => handleRecorderHook({
    provider: 'qoder', event, workspace: root, deferDelivery: true, qoderStopRecoveryScheduled: true,
    payload: { session_id: sessionId, transcript_path: transcript, cwd: root, hook_event_name: event,
      permission_mode: 'default', workspace_dirs: [root], ...payload }
  })
  const start = (id: string, req?: string, native?: string) => hook('UserPromptSubmit', {
    ...(req ? { request_set_id: req } : {}), ...(native ? { promptId: native } : {}), prompt: `fixture question ${id}`
  })
  const stop = (extra: object = {}) => hook('Stop', { stop_hook_active: false, model: 'synthetic',
    last_assistant_message: 'same reply', parent_business_info: {}, ...extra })
  const records = () => listRecords(dataRoot)
  const poll = () => recoverRecorder(root, {}, undefined, undefined, { incremental: true })
  const state = async (): Promise<RecorderOpenTurnState> => JSON.parse(await readFile(recorderOpenPath(sessionRoot), 'utf8'))
  const history = async (): Promise<RecorderSessionState> => JSON.parse(await readFile(recorderStatePath(sessionRoot), 'utf8'))
  const heldEventExists = async () => {
    const open = await state()
    const files = await readdir(join(recorderTurnRoot(sessionRoot, open.generation), 'events'))
    return !!open.deferredTerminalEventId && files.includes(`${open.deferredTerminalEventId}.json`)
  }
  const log = () => readFile(join(dataRoot, 'logs', 'recorder.log'), 'utf8')
  const edit = () => writeFile(join(root, 'example.txt'), 'after\n')
  const ageClosing = (ageMs: number) => {
    const timestamp = new Date(Date.now() - ageMs)
    return utimes(recorderOpenPath(sessionRoot), timestamp, timestamp)
  }
  return { start, stop, hook, row, user, reply, records, poll, state, history, heldEventExists, log, edit, ageClosing }
}

it('commits a matched Stop with transcript and Git diff on the first poll after a one-second late transcript', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const stoppedAt = Date.now()
  const f = await fixture(true)
  await f.start('short', 'request-short')
  await f.edit()
  expect(await f.stop({ parent_request_set_id: 'request-short' })).toMatchObject({ status: 'pending' })
  expect(await f.records()).toHaveLength(0)
  vi.setSystemTime(stoppedAt + 1_000)
  await f.user('short', null, 'request-short')
  await f.reply('short')
  expect(await f.poll()).toMatchObject({ recovered: 1, pending: 0 })
  expect(await f.records()).toMatchObject([{
    status: 'completed', transcript: { status: 'available' },
    assistant: { value: { text: 'same reply' } }, diff: { status: 'available' },
    termination: { value: { completedAtSource: 'recorder_observed_terminal' } }
  }])
  expect(await f.log()).toContain('qoder_stop_attribution attribution=matched')
})

it('waits for the final reply even when the current prompt already matches', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const stoppedAt = Date.now()
  const f = await fixture(true)
  await f.user('short', null, 'request-short')
  await f.start('short', 'request-short')
  await f.edit()
  expect(await f.stop({ parent_request_set_id: 'request-short' })).toMatchObject({ status: 'pending' })
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  vi.setSystemTime(stoppedAt + 1_000)
  await f.reply('short')
  expect(await f.poll()).toMatchObject({ recovered: 1, pending: 0 })
  expect(await f.records()).toMatchObject([{
    assistant: { status: 'available', value: { text: 'same reply' } }, diff: { status: 'available' }
  }])
})

it('degrades a matched Stop only after the ten-second transcript deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const stoppedAt = Date.now()
  const f = await fixture(true)
  await f.start('short', 'request-short')
  await f.edit()
  expect(await f.stop({ parent_request_set_id: 'request-short' })).toMatchObject({ status: 'pending' })
  vi.setSystemTime(stoppedAt + QODER_STOP_TRANSCRIPT_WAIT_MS - 1)
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  vi.setSystemTime(stoppedAt + QODER_STOP_TRANSCRIPT_WAIT_MS)
  expect(await f.poll()).toMatchObject({ recovered: 1, pending: 0 })
  expect(await f.records()).toMatchObject([{
    status: 'completed', transcript: { status: 'unavailable', omissionReason: expect.stringContaining('10-second wait expired') },
    diff: { status: 'available' }
  }])
})

it('discards the diff after the deadline if a readable transcript belongs to another turn', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const stoppedAt = Date.now()
  const f = await fixture(true)
  await f.user('other', null, 'request-other')
  await f.reply('other')
  await f.start('short', 'request-short')
  await f.edit()
  expect(await f.stop({ parent_request_set_id: 'request-short' })).toMatchObject({ status: 'pending' })
  vi.setSystemTime(stoppedAt + QODER_STOP_TRANSCRIPT_WAIT_MS)
  expect(await f.poll()).toMatchObject({ recovered: 1 })
  expect(await f.records()).toMatchObject([{
    status: 'completed', diff: { status: 'unavailable', omissionReason: expect.stringContaining('10-second wait expired') },
    transcript: { status: 'unavailable' }
  }])
})

it('opens and baselines the next prompt 100 ms after a matched Stop pending its final reply', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const stoppedAt = Date.now()
  const f = await fixture(true)
  await f.user('first', null, 'request-first')
  await f.start('first', 'request-first')
  await f.edit()
  expect(await f.stop({ parent_request_set_id: 'request-first' })).toMatchObject({ status: 'pending' })
  vi.setSystemTime(stoppedAt + 100)
  expect(await f.start('next', 'request-next')).toMatchObject({ status: 'started' })
  expect(await f.state()).toMatchObject({
    startedAt: new Date(stoppedAt + 100).toISOString(), status: 'open',
    requestSetId: 'request-next', captures: [{ capture: { status: 'ready' } }]
  })
  expect(await f.records()).toMatchObject([{
    status: 'completed', diff: { status: 'available' },
    transcript: { status: 'partial', omissionReason: expect.stringContaining('the next prompt arrived') }
  }])
})

it('rejects the interrupted request Stop even after the replacement has the same final reply and a complete parent chain', async () => {
  const f = await fixture()
  await f.user('old', null, 'request-old')
  await f.start('old', 'request-old')
  await f.reply('old')
  await f.start('next', 'request-next')
  await f.user('next', 'old-reply', 'request-next')
  await f.hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'read-next' })
  await f.row({ type: 'attachment', uuid: 'attachment', parentUuid: 'next' })
  await f.reply('next', 'attachment')
  expect((await f.history()).recentQoderRequests).toEqual([
    { generation: 1, id: 'request-old' }, { generation: 2, id: 'request-next' }
  ])
  expect(await f.stop({ parent_request_set_id: 'request-old' })).toMatchObject({ status: 'duplicate' })
  expect(await f.state()).toMatchObject({ status: 'open', requestSetId: 'request-next' })
  expect(await f.records()).toMatchObject([{ providerTurnId: 'old', status: 'interrupted' }])
  expect(await f.stop({ parent_request_set_id: 'request-next' })).toMatchObject({ status: 'committed' })
  expect(await f.records()).toMatchObject([{ providerTurnId: 'old' }, { providerTurnId: 'next', status: 'completed' }])
  const log = await f.log()
  expect(log).toContain('qoder_stop_attribution attribution=stale')
  expect(log).not.toMatch(/request-old|request-next|same reply|qoder-stop-fixture/)
})

it.each([
  { name: 'missing field', opened: 'request-a', terminal: undefined },
  { name: 'missing opening ID', opened: undefined, terminal: 'request-a' },
  { name: 'unknown ID', opened: 'request-a', terminal: 'unknown' },
  { name: 'non-string ID', opened: 'request-a', terminal: 5 }
])('keeps the 180s anonymous guard for $name, even on a root prompt with matching final text', async ({ opened, terminal }) => {
  const f = await fixture()
  await f.user('first', null, opened)
  await f.start('first', opened)
  await f.reply('first')
  expect(await f.stop(terminal === undefined ? {} : { parent_request_set_id: terminal })).toMatchObject({ status: 'pending' })
  expect(await f.state()).toHaveProperty('deferredTerminalReason', 'stale_terminal')
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  expect(await f.records()).toHaveLength(0)
  await f.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'resumed' })
  expect(await f.state()).not.toHaveProperty('deferredTerminalAt')
  expect(await f.log()).toMatch(/reason=stale_terminal outcome=activity attribution=unproven waitedMs=\d+/)
})

it.each(['SubagentStop', 'Stop'])('treats child %s as activity without attributing or sealing the parent', async (event) => {
  const f = await fixture()
  await f.start('parent', 'request-parent')
  await f.stop()
  expect(await f.state()).toHaveProperty('deferredTerminalEventId')
  const child = { parent_request_set_id: 'request-parent', promptId: 'child-native', agent_id: 'child', agent_type: 'worker' }
  expect(await f.hook(event, child)).toMatchObject({ status: 'recorded' })
  const open = await f.state()
  expect(open.status).toBe('open')
  expect(open).not.toHaveProperty('deferredTerminalAt')
  expect(await f.records()).toHaveLength(0)
  const log = await f.log()
  expect(log.match(/qoder_stop_attribution/g)).toHaveLength(1)
  expect(log).toContain('outcome=activity attribution=unproven')
})

it('keeps the background-task hold for a matched request', async () => {
  const f = await fixture()
  await f.user('first', null, 'request-a')
  await f.start('first', 'request-a')
  await f.row({ type: 'user', parentUuid: 'first', uuid: 'launch', toolUseResult: { kind: 'async_launched', taskId: 'bg' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'running' }] } })
  await f.reply('first', 'launch')
  expect(await f.stop({ parent_request_set_id: 'request-a' })).toMatchObject({ status: 'pending' })
  expect(await f.state()).toHaveProperty('deferredTerminalReason', 'pending_background_tasks')
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  expect(await f.records()).toHaveLength(0)
  expect(await f.log()).toContain('reason=pending_background_tasks outcome=deferred attribution=matched')
})

it('persists an early native-ID Stop and finalizes after the next poll proves its request mapping without a reply', async () => {
  const f = await fixture()
  await f.start('first', 'request-a')
  expect(await f.stop({ promptId: 'native' })).toMatchObject({ status: 'pending' })
  expect(await f.heldEventExists()).toBe(true)
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  await f.user('native', null, 'request-a')
  expect(await f.poll()).toMatchObject({ recovered: 1 })
  expect(await f.records()).toMatchObject([{ providerTurnId: 'native', status: 'completed' }])
  expect(await f.log()).toMatch(/reason=qoder_native_id_unproven outcome=native_id_matched attribution=matched waitedMs=\d+/)
})

it('rejects a native-ID Stop from another turn once the open request is mapped', async () => {
  const f = await fixture()
  await f.start('current', 'request-current')
  await f.user('other', null, 'request-other')
  await f.user('current', 'other', 'request-current')
  expect(await f.stop({ promptId: 'other' })).toMatchObject({ status: 'duplicate' })
  expect(await f.state()).toMatchObject({ status: 'open' })
  expect(await f.records()).toHaveLength(0)
})

it('revokes a persisted native-ID Stop if the next poll proves it belongs to a different turn', async () => {
  const f = await fixture()
  await f.start('current', 'request-current')
  expect(await f.stop({ promptId: 'other' })).toMatchObject({ status: 'pending' })
  expect(await f.heldEventExists()).toBe(true)
  await f.user('other', null, 'request-other')
  await f.user('current', 'other', 'request-current')
  expect(await f.poll()).toMatchObject({ recovered: 0 })
  expect(await f.state()).toMatchObject({ status: 'open' })
  expect(await f.state()).not.toHaveProperty('deferredTerminalEventId')
  expect(await f.log()).toContain('outcome=native_id_mismatch attribution=stale')
})

it('expires an unresolved native Stop at the closing expiry, without attributing its terminal event', async () => {
  const f = await fixture()
  await f.start('current', 'request-current')
  expect(await f.stop({ promptId: 'other' })).toMatchObject({ status: 'pending' })
  await f.ageClosing(181_000)
  expect(await f.poll()).toMatchObject({ recovered: 0, pending: 1 })
  await f.ageClosing(24 * 60 * 60 * 1_000 + 1_000)
  expect(await f.poll()).toMatchObject({ recovered: 1, pending: 0, expired: 1 })
  const [record] = await f.records()
  expect(record.status).toBe('interrupted')
  expect(record.providerTurnId).toBeUndefined()
  expect(record.diff.omissionReason).toContain('native turn identity was never confirmed')
  await expect(f.state()).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.log()).toContain('outcome=native_id_expired attribution=unproven')
})

it('bounds history to 32 generations and treats a reused current ID as ambiguous', () => {
  const seen = (generation: number, id: string) => ({ provider: 'qoder', sessionId: 's', requestSetId: id, generation } as RecorderOpenTurnState)
  let state: RecorderSessionState = { schemaVersion: 1, lastGeneration: 0, lastTurnIndex: 0 }
  for (let i = 1; i <= 40; i++) state = rememberQoderRequest(state, seen(i, `req-${i}`))
  expect(state.recentQoderRequests).toHaveLength(32)
  const open = seen(41, 'req-40')
  const status = (id: string) => qoderRequestStopAttribution({ session_id: 's', parent_request_set_id: id }, open, state)
  expect(status('req-40')).toBe('unproven')
  expect(status('req-9')).toBe('stale')
  expect(status('req-8')).toBe('unproven')
})
