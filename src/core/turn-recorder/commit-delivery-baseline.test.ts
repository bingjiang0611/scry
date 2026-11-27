import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRecorderHook, drainRecorderDelivery, recoverRecorder } from './recorder.js'
import { commitNotificationStatus, drainCommitNotifications, listRecords, redeliverLatestCommitNotification, stableHash } from './store.js'
import { saveOutcome } from './commit-delivery-ledger.js'
import { COMMIT_NOTIFICATION_MAX_FAILURES, commitHookStatePath, publishDeadLetter } from './commit-delivery-state.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  root: string
  dataRoot: string
  calls: string
  blocked: string
  env: NodeJS.ProcessEnv
  noHook: NodeJS.ProcessEnv
  readCalls: () => Promise<number[]>
  at: (fingerprint: string) => NodeJS.ProcessEnv
  latest: () => Promise<number>
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'scry-delivery-baseline-'))
  roots.push(root)
  const dataRoot = join(root, '.scry')
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'delivery-baseline',
    capture: { prompt: true, assistant: true, diff: false, toolOutput: 'summary', hooks: true }
  }))
  const calls = join(root, 'calls.jsonl')
  const blocked = join(root, 'blocked.json')
  const hook = join(root, 'receiver.cjs')
  await writeFile(blocked, '[]')
  await writeFile(hook, `#!${process.execPath}
const fs = require('node:fs')
const n = JSON.parse(fs.readFileSync(0, 'utf8'))
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(n.sequence) + '\\n')
process.exit(JSON.parse(fs.readFileSync(${JSON.stringify(blocked)}, 'utf8')).includes(n.sequence) ? 1 : 0)
`)
  await chmod(hook, 0o700)
  const base = { HOME: root, XDG_STATE_HOME: join(root, 'state'), SCRY_GRANT_DIR: join(root, 'grants') }
  const env = { ...base, SCRY_RECORDER_COMMIT_HOOK: hook, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'policy-v1' }
  return {
    root, dataRoot, calls, blocked, env,
    noHook: base,
    at: (fingerprint: string) => ({ ...env, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: fingerprint }),
    readCalls: async () => {
      const text = await readFile(calls, 'utf8').catch(() => '')
      return text.trim() === '' ? [] : text.trim().split('\n').map(Number)
    },
    latest: async () => (await listRecords(dataRoot)).at(-1)?.sequence ?? 0
  }
}

async function commitTurn(f: Fixture, turn: number, env: NodeJS.ProcessEnv, deliver: boolean): Promise<void> {
  for (const event of ['UserPromptSubmit', 'Stop']) {
    await handleRecorderHook({
      workspace: f.root, provider: 'pi', event, env, deferDelivery: !deliver,
      payload: { session_id: 'session', turn_id: `turn-${turn}`, prompt: 'fixture', assistant_response: 'done' }
    }, env)
  }
}

async function pump(f: Fixture, env: NodeJS.ProcessEnv, triggerSequence?: number): Promise<void> {
  await drainCommitNotifications(f.dataRoot, env, triggerSequence === undefined ? {} : { triggerSequence })
}

describe('commit delivery baseline', () => {
  it('delivers the first record of a fresh workspace', async () => {
    const f = await fixture()
    await commitTurn(f, 1, f.env, true)

    expect(await f.readCalls()).toEqual([1])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ ackedThrough: 1, notifyBacklog: 0 })
  }, 20_000)

  it('continues a changed fingerprint at the previous confirmed position', async () => {
    const f = await fixture()
    await commitTurn(f, 1, f.env, true)
    await commitTurn(f, 2, f.env, true)
    expect(await f.readCalls()).toEqual([1, 2])

    await commitTurn(f, 3, f.at('policy-v2'), true)
    expect(await f.readCalls()).toEqual([1, 2, 3])
    expect(await commitNotificationStatus(f.dataRoot, f.at('policy-v2'))).toMatchObject({ ackedThrough: 3 })
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ ackedThrough: 2 })
  }, 20_000)

  it('delivers the untouched backlog when the fingerprint changes', async () => {
    const f = await fixture()
    await commitTurn(f, 1, f.env, true)
    await commitTurn(f, 2, f.env, false)
    await commitTurn(f, 3, f.env, false)
    expect(await f.readCalls()).toEqual([1])

    await commitTurn(f, 4, f.at('policy-v2'), true)
    expect(await f.readCalls()).toEqual([1, 2, 3, 4])
    expect(await commitNotificationStatus(f.dataRoot, f.at('policy-v2'))).toMatchObject({ ackedThrough: 4 })
  }, 20_000)

  it('carries the old backlog into a changed fingerprint and keeps a scheduled retry waiting', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[2]')
    await commitTurn(f, 1, f.env, true)
    await commitTurn(f, 2, f.env, true)
    await commitTurn(f, 3, f.env, true)
    expect(await f.readCalls()).toEqual([1, 2, 3])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ ackedThrough: 1, retryCount: 1 })

    await writeFile(f.blocked, '[]')
    await commitTurn(f, 4, f.at('policy-v2'), true)
    expect(await f.readCalls()).toEqual([1, 2, 3, 4])
    expect(await commitNotificationStatus(f.dataRoot, f.at('policy-v2'))).toMatchObject({ ackedThrough: 1, retryCount: 1 })

    const state = JSON.parse(await readFile(commitHookStatePath(f.dataRoot, 'policy-v2'), 'utf8'))
    const outcome = JSON.parse(await readFile(join(f.dataRoot, 'notifications/delivery-outcomes',
      stableHash('policy-v2'), '00000000000000000002.json'), 'utf8'))
    expect(state.hookFingerprint).toBe('policy-v2')
    expect(outcome).toMatchObject({ status: 'retry', failure: { sequence: 2, attempts: 1 } })
  }, 20_000)

  it('does not revive a dead letter when the fingerprint changes', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[1]')
    await commitTurn(f, 1, f.env, true)
    const records = await listRecords(f.dataRoot)
    const failure = { sequence: 1, recordId: records[0].recordId, attempts: COMMIT_NOTIFICATION_MAX_FAILURES,
      lastFailureAt: new Date().toISOString(), reason: 'exit' as const, exitCode: 1 }
    await saveOutcome(f.dataRoot, 'policy-v1', { sequence: 1, recordId: records[0].recordId, status: 'dead', failure })
    await publishDeadLetter(f.dataRoot, 'policy-v1', failure)
    expect(await f.readCalls()).toEqual([1])

    await writeFile(f.blocked, '[]')
    await commitTurn(f, 2, f.at('policy-v2'), true)
    expect(await f.readCalls()).toEqual([1, 2])
    expect(await commitNotificationStatus(f.dataRoot, f.at('policy-v2'))).toMatchObject({ deadLetterCount: 1 })
  }, 20_000)

  it('inherits the fingerprint with the most recent delivery activity, not the highest or the lowest', async () => {
    const f = await fixture()
    for (const [turn, fingerprint] of [[1, 'policy-low'], [2, 'policy-mid'], [3, 'policy-high']] as const) {
      await commitTurn(f, turn, f.noHook, true)
      await pump(f, f.at(fingerprint), turn)
    }
    expect(await f.readCalls()).toEqual([1, 2, 3])

    const later = new Date(Date.now() + 60_000)
    await utimes(commitHookStatePath(f.dataRoot, 'policy-mid'), later, later)
    await commitTurn(f, 4, f.at('policy-next'), true)
    expect(await f.readCalls()).toEqual([1, 2, 3, 3, 4])
    expect(await commitNotificationStatus(f.dataRoot, f.at('policy-next'))).toMatchObject({ ackedThrough: 4 })
  }, 20_000)

  it('does not send existing records when the hook appears for the first time', async () => {
    const f = await fixture()
    await commitTurn(f, 1, f.noHook, true)
    await commitTurn(f, 2, f.noHook, true)
    expect(await f.readCalls()).toEqual([])

    await pump(f, f.env)
    expect(await f.readCalls()).toEqual([])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ ackedThrough: null })

    await commitTurn(f, 3, f.env, true)
    expect(await f.readCalls()).toEqual([3])
    await pump(f, f.env, 3)
    expect(await f.readCalls()).toEqual([3])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ ackedThrough: 3 })
  }, 20_000)

  it('sends nothing without a checkpoint from the daemon startup and from recovery', async () => {
    const f = await fixture()
    await commitTurn(f, 1, f.noHook, true)
    await commitTurn(f, 2, f.noHook, true)
    await drainRecorderDelivery(f.root, f.env)
    await recoverRecorder(f.root, f.env)

    expect(await f.readCalls()).toEqual([])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ ackedThrough: null })
  }, 20_000)

  it('leaves an acknowledged record alone', async () => {
    const f = await fixture()
    await commitTurn(f, 1, f.env, true)
    expect(await f.readCalls()).toEqual([1])

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, sequence: 1, reason: 'already acknowledged; no redelivery'
    })
    expect(await f.readCalls()).toEqual([1])
  }, 20_000)

  it('retries an unacknowledged record once and then treats it as acknowledged', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[1]')
    await commitTurn(f, 1, f.env, true)
    expect(await f.readCalls()).toEqual([1])

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, sequence: 1, reason: 'scheduled retry; use normal notification drain'
    })
    expect(await f.readCalls()).toEqual([1])
    expect(await commitNotificationStatus(f.dataRoot, f.env)).toMatchObject({ failure: { sequence: 1, attempts: 1 } })
  }, 20_000)

  it('does not record a rejected callback as acknowledged', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[1]')
    await commitTurn(f, 1, f.env, true)

    const status = await commitNotificationStatus(f.dataRoot, f.env)
    expect(status).toMatchObject({ ackedThrough: 0, failure: { sequence: 1, attempts: 1 } })
    expect(await f.readCalls()).toEqual([1])
  }, 20_000)

  it('leaves dead letters to the normal drain and keeps the redelivery path off scheduled retries', async () => {
    const f = await fixture()
    await writeFile(f.blocked, '[1]')
    await commitTurn(f, 1, f.env, true)
    const records = await listRecords(f.dataRoot)
    const failure = { sequence: 1, recordId: records[0].recordId, attempts: COMMIT_NOTIFICATION_MAX_FAILURES,
      lastFailureAt: new Date().toISOString(), reason: 'exit' as const, exitCode: 1 }
    await saveOutcome(f.dataRoot, 'policy-v1', { sequence: 1, recordId: records[0].recordId, status: 'dead', failure })
    await publishDeadLetter(f.dataRoot, 'policy-v1', failure)

    await expect(redeliverLatestCommitNotification(f.dataRoot, f.env)).resolves.toMatchObject({
      delivered: false, sequence: 1, reason: 'recorder dead letter; automatic redelivery disabled'
    })
    expect(await f.readCalls()).toEqual([1])
  }, 20_000)
})