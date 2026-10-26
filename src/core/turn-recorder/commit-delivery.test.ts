import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRecorderHook, drainRecorderDelivery } from './recorder.js'
import { commitNotificationStatus, drainCommitNotifications, redeliverLatestCommitNotification, listRecords, stableHash } from './store.js'
import { resolveCommitHookActivation, commitHookEnv } from './commit-hook-grant.js'
import * as io from './io.js'
import { doctorCommand } from '../../cli/doctor-command.js'
import { recordsCommand } from '../../cli/records-command.js'
import { recorderCommand } from '../../cli/recorder-command.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scry-delivery-'))
  roots.push(root)
  const dataRoot = join(root, '.scry')
  const config = { schemaVersion: 1, enabled: true, workspaceId: 'delivery-fixture',
    capture: { prompt: true, assistant: true, diff: false, toolOutput: 'summary', hooks: true } }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
  const hook = join(root, 'receiver.cjs')
  const calls = join(root, 'calls.jsonl'), blocked = join(root, 'blocked.json')
  await writeFile(blocked, '[1]')
  await writeFile(hook, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const n = JSON.parse(fs.readFileSync(0, 'utf8'))
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(n.sequence) + '\\n')
let bytes = fs.readFileSync(path.join(${JSON.stringify(dataRoot)}, n.recordPath))
if (JSON.parse(fs.readFileSync(${JSON.stringify(blocked)}, 'utf8')).includes(n.sequence)) bytes = Buffer.concat([bytes, Buffer.from('corruption')])
if (crypto.createHash('sha256').update(bytes).digest('hex') !== n.sha256) process.exit(71)
const target = path.join(${JSON.stringify(root)}, 'accepted-' + n.sequence + '.json')
fs.writeFileSync(target, bytes, { mode: 0o600 })
const fd = fs.openSync(target, 'r'); fs.fsyncSync(fd); fs.closeSync(fd)
`)
  await chmod(hook, 0o700)
  const env = { HOME: root, XDG_STATE_HOME: join(root, 'state'), SCRY_GRANT_DIR: join(root, 'grants'),
    SCRY_RECORDER_COMMIT_HOOK: hook, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'delivery-fixture-v1' }
  for (let i = 1; i <= 3; i++) {
    for (const event of ['UserPromptSubmit', 'Stop']) {
      await handleRecorderHook({ workspace: root, provider: 'pi', event, deferDelivery: true,
        payload: { session_id: 'session', turn_id: `turn-${i}`, prompt: 'fixture', assistant_response: 'done' } }, env)
    }
  }
  const records = (await listRecords(dataRoot)).sort((a, b) => a.sequence - b.sequence)
  expect(records).toHaveLength(3)
  const statePath = join(dataRoot, 'notifications', 'commit-hooks', `${stableHash(env.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT)}.json`)
  const readCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n').map(Number)
  let clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  return { root, dataRoot, config, hook, env, blocked, records, statePath, readCalls, advance: (milliseconds: number) => { clock += milliseconds } }
}

async function doctor(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value)
  const chunks: string[] = []
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true })
  try {
    const code = await doctorCommand({ positionals: [], flags: new Map([['workspace', f.root]]) })
    const report = JSON.parse(chunks.join('')) as { checks: { id: string; status: string; detail: string }[] }
    return { code, check: report.checks.find(check => check.id === 'commitHook.delivery') }
  } finally { output.mockRestore(); vi.unstubAllEnvs() }
}

const backoffs = [60_000, 300_000, 900_000, 3_600_000]
async function exhaust(f: Awaited<ReturnType<typeof fixture>>, maxRecords?: number) {
  await drainCommitNotifications(f.dataRoot, f.env, { maxRecords })
  for (const delay of backoffs) {
    f.advance(delay)
    await drainCommitNotifications(f.dataRoot, f.env, { maxRecords })
  }
}

async function retry(f: Awaited<ReturnType<typeof fixture>>, flags: Map<string, string | true>, env: NodeJS.ProcessEnv = f.env) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try { return await recorderCommand({ positionals: ['recorder', 'notify-retry'], flags: new Map([['workspace', f.root], ...flags]) }) }
  finally { output.mockRestore(); vi.unstubAllEnvs() }
}

// VE2 changes scheduling, not the five-failure threshold or the conservative ACK contract.
describe('persistent commit notification failures', () => {
  it('reports the failed sequence, dead-letters at five, and delivers later records without claiming a contiguous ACK', async () => {
    const f = await fixture()
    await drainCommitNotifications(f.dataRoot, f.env)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({
      failure: { sequence: 1, attempts: 1, reason: 'exit', exitCode: 71 }
    })
    expect(await doctor(f)).toMatchObject({ code: 5, check: { status: 'warn', detail: expect.stringMatching(/sequence 1.*1 failed/) } })
    for (const delay of backoffs) { f.advance(delay); await drainCommitNotifications(f.dataRoot, f.env) }
    expect(await f.readCalls()).toEqual([1, 2, 3, 1, 1, 1, 1])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({
      ackedThrough: 0, processedThrough: 3, notifyBacklog: 0, deadLetterCount: 1,
      deadLetters: [expect.objectContaining({ sequence: 1, attempts: 5, reason: 'exit' })]
    })
    expect(await doctor(f)).toMatchObject({ code: 5, check: { status: 'fail', detail: expect.stringMatching(/sequence 1.*5 failed/) } })
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value)
    const archiveOutput: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { archiveOutput.push(String(chunk)); return true })
    try {
      expect(await recordsCommand({ positionals: ['records', 'archive'], flags: new Map<string, string | true>([
        ['workspace', f.root], ['before', '2099-01-01'], ['yes', true]
      ]) })).toBe(5)
      expect(JSON.parse(archiveOutput.join(''))).toMatchObject({ status: 'refused', reason: 'undelivered-records' })
    } finally { stdout.mockRestore(); vi.unstubAllEnvs() }
    expect(await listRecords(f.dataRoot)).toHaveLength(3)
    for (const sequence of [2, 3]) {
      expect(JSON.parse(await readFile(join(f.root, `accepted-${sequence}.json`), 'utf8'))).toMatchObject({ sequence })
    }
    await drainCommitNotifications(f.dataRoot, f.env)
    expect(await f.readCalls()).toEqual([1, 2, 3, 1, 1, 1, 1])
    const other = { ...f.env, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'independent-hook' }
    await drainCommitNotifications(f.dataRoot, other)
    expect(await commitNotificationStatus(f.dataRoot, other)).toMatchObject({ failure: { sequence: 1, attempts: 1 } })
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ deadLetterCount: 1, notifyBacklog: 0 })
  }, 15_000)

  it('starts an independent counter for the next failed sequence and reports both dead and blocked work', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[1,2]')
    await exhaust(f, 1)
    await drainCommitNotifications(f.dataRoot, f.env)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({
      ackedThrough: 0, processedThrough: 3, notifyBacklog: 1, deadLetterCount: 1,
      failure: { sequence: 2, attempts: 1 }
    })
    expect(await doctor(f)).toMatchObject({ code: 5, check: {
      detail: expect.stringMatching(/sequence 1: 5 failed.*sequence 2: 1 failed/)
    } })
  }, 15_000)

  it('does not wake an exhausted latest record again on the cold-start redelivery path', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[3]')
    await exhaust(f)
    const calls = await f.readCalls()
    expect(calls).toEqual([1, 2, 3, 3, 3, 3, 3])
    expect(await redeliverLatestCommitNotification(f.dataRoot, f.env)).toMatchObject({
      delivered: false, sequence: 3, reason: 'recorder dead letter; automatic redelivery disabled'
    })
    expect(await f.readCalls()).toEqual(calls)
  }, 15_000)

  it('clears a failure on successful retry before the threshold', async () => {
    const f = await fixture()
    await drainCommitNotifications(f.dataRoot, f.env)
    f.advance(backoffs[0])
    await drainCommitNotifications(f.dataRoot, f.env)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ failure: { sequence: 1, attempts: 2 } })
    await writeFile(f.blocked, '[]')
    f.advance(backoffs[1])
    expect(await drainCommitNotifications(f.dataRoot, f.env)).toMatchObject({ delivered: 1, pending: 0 })
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toEqual({ ackedThrough: 3, notifyBacklog: 0 })
    expect(await doctor(f)).toMatchObject({ code: 0, check: { status: 'pass' } })
  }, 15_000)

  it('retains a known failed sequence when its canonical source disappears, then progresses', async () => {
    const f = await fixture()
    await drainCommitNotifications(f.dataRoot, f.env)
    const filename = (await readdir(join(f.dataRoot, 'records'))).find(name => name.includes(f.records[0].recordId))!
    await rm(join(f.dataRoot, 'records', filename))
    for (const delay of backoffs) { f.advance(delay); await drainCommitNotifications(f.dataRoot, f.env) }
    expect(await f.readCalls()).toEqual([1, 2, 3])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({
      processedThrough: 3, notifyBacklog: 0, deadLetterCount: 1,
      deadLetters: [expect.objectContaining({ sequence: 1, attempts: 5, reason: 'record_unavailable' })]
    })
  }, 15_000)

  it('recovers after durable dead-letter publication without a sixth callback', async () => {
    const f = await fixture()
    await drainCommitNotifications(f.dataRoot, f.env)
    for (const delay of backoffs.slice(0, 3)) { f.advance(delay); await drainCommitNotifications(f.dataRoot, f.env) }
    const original = io.writeJsonAtomic
    let injected = false
    const writer = vi.spyOn(io, 'writeJsonAtomic').mockImplementation(async (path, value, options) => {
      await original(path, value, options)
      if (path.includes('/dead-letters/')) { injected = true; throw new Error('fixture crash after dead publication') }
    })
    f.advance(backoffs[3])
    await drainCommitNotifications(f.dataRoot, f.env)
    writer.mockRestore()
    expect(injected).toBe(true)
    const calls = await f.readCalls()
    expect(calls).toEqual([1, 2, 3, 1, 1, 1, 1])
    await drainCommitNotifications(f.dataRoot, f.env, { maxRecords: 1 })
    expect(await f.readCalls()).toEqual(calls)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ deadLetterCount: 1, notifyBacklog: 0 })
  }, 15_000)

  it.each(['counter', 'null', 'identity'])('does not reset corrupt %s state or execute a callback with unavailable state', async corruption => {
    const f = await fixture()
    await drainCommitNotifications(f.dataRoot, f.env)
    const state = JSON.parse(await readFile(f.statePath, 'utf8')) as Record<string, unknown>
    const corrupt = corruption === 'null' ? null : corruption === 'identity' ? { ...state, hookFingerprint: 'wrong-identity' }
      : { ...state, failure: { sequence: 1, recordId: f.records[0].recordId, attempts: 'invalid' } }
    await writeFile(f.statePath, JSON.stringify(corrupt))
    await expect(drainCommitNotifications(f.dataRoot, f.env)).rejects.toThrow(/notification.*state/)
    expect(await f.readCalls()).toEqual([1, 2, 3])
    expect(await doctor(f)).toMatchObject({ code: 5, check: { status: 'fail', detail: expect.stringContaining('unavailable') } })
  }, 15_000)

  it('does not count global trust rejection as a failed record or execute the rejected hook', async () => {
    const f = await fixture()
    const config = { ...f.config, commitHook: { entry: 'receiver.cjs', files: ['receiver.cjs'] } }
    await writeFile(join(f.root, 'scry.config.json'), JSON.stringify(config))
    const baseEnv = { HOME: f.root, SCRY_GRANT_DIR: join(f.root, 'grants') }
    // Load the validated config through the public recorder path before inspecting its state.
    await drainRecorderDelivery(f.root, baseEnv)
    const { recorderEnablement } = await import('./recorder.js')
    const enabled = await recorderEnablement(f.root, baseEnv)
    if (!enabled.enabled) throw new Error('fixture not enabled')
    const activation = await resolveCommitHookActivation(f.root, enabled.config, baseEnv)
    const activeEnv = commitHookEnv(activation, baseEnv)
    const before = await commitNotificationStatus(f.dataRoot, activeEnv)
    expect(before).toMatchObject({ failure: { sequence: 1, attempts: 1 } })
    await writeFile(join(f.root, 'scry.config.json'), JSON.stringify({ ...config, commitHook: { entry: '../outside.cjs', files: ['../outside.cjs'] } }))
    for (let i = 0; i < 5; i++) await drainRecorderDelivery(f.root, baseEnv)
    expect(await f.readCalls()).toEqual([1, 2, 3])
    expect(await commitNotificationStatus(f.dataRoot, activeEnv)).toEqual(before)
  }, 15_000)

  it('rapid drains and cold-start wakeups respect the retry time while later records continue', async () => {
    const f = await fixture()
    await drainCommitNotifications(f.dataRoot, f.env)
    const nextRetryAt = new Date(Date.now() + backoffs[0]).toISOString()
    for (let i = 0; i < 5; i++) await drainCommitNotifications(f.dataRoot, f.env)
    expect(await f.readCalls()).toEqual([1, 2, 3])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({
      ackedThrough: 0, processedThrough: 3, notifyBacklog: 1,
      failure: { sequence: 1, attempts: 1, nextRetryAt }
    })
    expect((await doctor(f)).check?.detail).toContain(nextRetryAt)
    f.advance(backoffs[0] - 1)
    await drainCommitNotifications(f.dataRoot, f.env)
    expect(await f.readCalls()).toEqual([1, 2, 3])
    f.advance(1)
    await drainCommitNotifications(f.dataRoot, f.env)
    expect(await f.readCalls()).toEqual([1, 2, 3, 1])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ failure: {
      attempts: 2, nextRetryAt: new Date(Date.now() + backoffs[1]).toISOString()
    } })
  }, 15_000)

  it('does not bypass a pending latest retry through automatic cold-start redelivery', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[3]')
    await drainCommitNotifications(f.dataRoot, f.env)
    for (let i = 0; i < 5; i++) expect(await redeliverLatestCommitNotification(f.dataRoot, f.env)).toMatchObject({ delivered: false })
    expect(await f.readCalls()).toEqual([1, 2, 3])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ failure: { sequence: 3, attempts: 1 } })
  }, 15_000)

  it('explicit sequence and all-dead replay preserve history, reset attempts and close ACK holes', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[1,2]')
    await exhaust(f)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ ackedThrough: 0, deadLetterCount: 2 })
    // A still-failing explicit replay starts a new episode, not an automatic sixth attempt.
    expect(await retry(f, new Map([['sequence', '1']]))).toBe(3)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({
      ackedThrough: 0, deadLetterCount: 1, failure: { sequence: 1, attempts: 1 }
    })
    await writeFile(f.blocked, '[]')
    f.advance(backoffs[0])
    await drainCommitNotifications(f.dataRoot, f.env)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ ackedThrough: 1, deadLetterCount: 1 })
    expect(await retry(f, new Map([['all-dead', true]]))).toBe(0)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toEqual({ ackedThrough: 3, notifyBacklog: 0 })
    const history = join(f.dataRoot, 'notifications', 'dead-letter-history', stableHash(f.env.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT))
    const files = await readdir(history)
    expect(files).toHaveLength(2)
    for (const file of files) expect(JSON.parse(await readFile(join(history, file), 'utf8'))).toMatchObject({ attempts: 5 })
    expect(await listRecords(f.dataRoot)).toHaveLength(3)
  }, 15_000)

  it('rejects replay before changing dead letters when repository trust validation fails', async () => {
    const f = await fixture()
    await exhaust(f)
    const before = await commitNotificationStatus(f.dataRoot, f.env)
    const calls = await f.readCalls()
    await writeFile(join(f.root, 'scry.config.json'), JSON.stringify({ ...f.config, commitHook: { entry: '../outside.cjs', files: ['../outside.cjs'] } }))
    expect(await retry(f, new Map([['all-dead', true]]), { ...f.env, SCRY_RECORDER_COMMIT_HOOK: undefined, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: undefined })).toBe(3)
    expect(await f.readCalls()).toEqual(calls)
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toEqual(before)
  }, 15_000)
})
