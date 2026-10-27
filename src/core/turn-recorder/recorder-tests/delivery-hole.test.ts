import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { doctorCommand } from '../../../cli/doctor-command.js'
import { recorderCommand } from '../../../cli/recorder-command.js'
import { advanceAck } from '../commit-delivery-ledger'
import { commitNotificationStatus, drainCommitNotifications, stableHash } from '../store'
import { completeTurn, workspace } from './fixture.test'

/**
 * VF2: ACK advancement used to require a delivery outcome for every sequence in the visited
 * prefix. A reserved-but-unwritten sequence (or a record deleted outside `scry turns archive`)
 * left a hole with no outcome, so `advanceAck` threw, the drain catch re-threw it through
 * `pendingCount`, and every later drain/status call failed — new records were never delivered.
 *
 * A hole may be crossed, but only with durable evidence; a sequence that still has a record file
 * but lost its delivery result must stay fail closed.
 */
export function registerSuite22(): void {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const fingerprint = 'delivery-hole-fixture-v1'
  const outcomesDir = (dataRoot: string) => join(dataRoot, 'notifications', 'delivery-outcomes', stableHash(fingerprint))
  const absentPath = (dataRoot: string) => join(outcomesDir(dataRoot), 'absent-sequences.json')
  const pad = (sequence: number) => `${String(sequence).padStart(20, '0')}.json`

  async function fixture() {
    const root = await workspace()
    const dataRoot = join(root, '.scry')
    const calls = join(root, 'calls.jsonl')
    const reject = join(root, 'reject.json')
    await writeFile(reject, '[]')
    const hook = join(root, 'receiver.cjs')
    await writeFile(hook, `#!${process.execPath}
const fs = require('node:fs')
const notification = JSON.parse(fs.readFileSync(0, 'utf8'))
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(notification.sequence) + '\\n')
if (JSON.parse(fs.readFileSync(${JSON.stringify(reject)}, 'utf8')).includes(notification.sequence)) process.exit(1)
`)
    await chmod(hook, 0o700)
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SCRY_RECORDER_COMMIT_HOOK: hook, SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: fingerprint }
    let clock = Date.parse('2026-10-27T00:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    return {
      root, dataRoot, env, calls,
      advance: (milliseconds: number) => { clock += milliseconds },
      rejectSequences: async (sequences: number[]) => { await writeFile(reject, JSON.stringify(sequences)) },
      callSequences: async () => (await readFile(calls, 'utf8')).trim().split('\n').map(Number)
    }
  }

  async function notifyRetry(f: Awaited<ReturnType<typeof fixture>>, flags: Array<[string, string]>): Promise<number> {
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value)
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      return await recorderCommand({ positionals: ['recorder', 'notify-retry'], flags: new Map([['workspace', f.root], ...flags]) })
    } finally {
      output.mockRestore()
      vi.unstubAllEnvs()
    }
  }

  async function absentEvidence(dataRoot: string) {
    try {
      return JSON.parse(await readFile(absentPath(dataRoot), 'utf8')) as { count: number; ranges: [number, number][]; truncated: boolean }
    } catch {
      return null
    }
  }

  it('crosses the sequence reserved before a crash and keeps delivering after the retry succeeds', async () => {
    const f = await fixture()
    await completeTurn(f.root, 'turn-1')
    await f.rejectSequences([1])
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 0 })
    await expect(commitNotificationStatus(f.dataRoot, f.env)).resolves.toMatchObject({ ackedThrough: 0, processedThrough: 1 })

    // Simulate a commit that reserved sequence 2 and crashed before writing the record file.
    await writeFile(join(f.dataRoot, 'sequence-watermark.json'), JSON.stringify({ schemaVersion: 1, lastIssued: 2 }))
    await completeTurn(f.root, 'turn-2')
    await drainCommitNotifications(f.dataRoot, f.env)
    await expect(f.callSequences()).resolves.toEqual([1, 3])

    await f.rejectSequences([])
    f.advance(60_000)
    // No sequence 2 record and no sequence 2 outcome must not block the ACK walk.
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 1, pending: 0, truncated: false })
    await expect(commitNotificationStatus(f.dataRoot, f.env)).resolves.toMatchObject({ ackedThrough: 3 })

    // The crossed hole is durable evidence, not a silent gap.
    expect(await absentEvidence(f.dataRoot)).toMatchObject({ count: 1, ranges: [[2, 2]], truncated: false })

    await completeTurn(f.root, 'turn-3')
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 1, pending: 0 })
    await expect(commitNotificationStatus(f.dataRoot, f.env)).resolves.toMatchObject({ ackedThrough: 4 })
    await expect(f.callSequences()).resolves.toEqual([1, 3, 1, 4])
  })

  it('crosses a record deleted outside archive while an earlier sequence is retrying', async () => {
    const f = await fixture()
    await completeTurn(f.root, 'turn-1')
    await f.rejectSequences([1])
    await drainCommitNotifications(f.dataRoot, f.env)
    // Sequence 2 is removed before any drain could record a delivery outcome for it.
    await completeTurn(f.root, 'turn-2')
    const second = (await readdir(join(f.dataRoot, 'records'))).find(name => name.startsWith(String(2).padStart(20, '0')))
    if (!second) throw new Error('record 2 not written')
    await rm(join(f.dataRoot, 'records', second), { force: true })
    await completeTurn(f.root, 'turn-3')
    await drainCommitNotifications(f.dataRoot, f.env)

    await f.rejectSequences([])
    f.advance(60_000)
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 1, pending: 0 })
    await expect(commitNotificationStatus(f.dataRoot, f.env)).resolves.toMatchObject({ ackedThrough: 3 })
    expect(await absentEvidence(f.dataRoot)).toMatchObject({ count: 1, ranges: [[2, 2]] })

    await completeTurn(f.root, 'turn-4')
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 1, pending: 0 })
    await expect(commitNotificationStatus(f.dataRoot, f.env)).resolves.toMatchObject({ ackedThrough: 4 })
  })

  it('stays fail closed when a record file exists but its delivery outcome is missing', async () => {
    const f = await fixture()
    for (const name of ['turn-1', 'turn-2', 'turn-3']) await completeTurn(f.root, name)
    await f.rejectSequences([1])
    await drainCommitNotifications(f.dataRoot, f.env)
    // Sequence 2 was delivered (its receipt exists), but the receipt is lost while the record stays.
    await rm(join(outcomesDir(f.dataRoot), pad(2)), { force: true })

    await f.rejectSequences([])
    f.advance(60_000)
    const result = await drainCommitNotifications(f.dataRoot, f.env)
    // Drained, but the unknown backlog is reported as unknown instead of a fabricated count.
    expect(result).toMatchObject({ truncated: false, pending: null })
    // The ACK never crosses a sequence whose record is still there: fail closed, loudly.
    await expect(commitNotificationStatus(f.dataRoot, f.env)).rejects.toThrow('missing delivery outcome in visited prefix')
    const checkpoint = JSON.parse(await readFile(join(f.dataRoot, 'notifications', 'commit-hooks', `${stableHash(fingerprint)}.json`), 'utf8')) as { ackedThrough: number }
    expect(checkpoint.ackedThrough).toBe(1)
    // Nothing was marked absent: a record with a lost result is not a hole.
    expect(await absentEvidence(f.dataRoot)).toBeNull()
  })

  it('keeps corrupt delivery evidence a loud rejection instead of reporting an unknown backlog', async () => {
    const f = await fixture()
    await completeTurn(f.root, 'turn-1')
    await drainCommitNotifications(f.dataRoot, f.env)
    await completeTurn(f.root, 'turn-2')
    // A damaged receipt is not a hole: nothing proves the record was handed over.
    await mkdir(outcomesDir(f.dataRoot), { recursive: true })
    await writeFile(join(outcomesDir(f.dataRoot), pad(2)), JSON.stringify({ schemaVersion: 1, hookFingerprint: fingerprint, sequence: 2, recordId: 'a'.repeat(32), status: 'bogus' }))
    await expect(drainCommitNotifications(f.dataRoot, f.env)).rejects.toThrow('invalid delivery outcome')

    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value)
    const broken = await doctor(f.root)
    expect(broken.code).toBe(5)
    expect(broken.report.status).toBe('error')
    expect(broken.report.checks.find(check => check.id === 'commitHook.delivery')?.status).toBe('fail')
  })

  it('counts a repeated absent sequence once even when the kept ranges are truncated', async () => {
    const f = await fixture()
    // A full sample: 32 ranges survive while holes 33..39 were already counted and trimmed away.
    const ranges = Array.from({ length: 32 }, (_, index) => [index + 1, index + 1] as [number, number])
    await mkdir(outcomesDir(f.dataRoot), { recursive: true })
    await writeFile(absentPath(f.dataRoot), JSON.stringify({
      schemaVersion: 1, hookFingerprint: fingerprint, absentThrough: 39, count: 39, ranges, truncated: true
    }))

    // Sequence 40 is the next hole; re-walking it must not be counted twice just because its
    // range fell outside the kept sample.
    for (let index = 0; index < 2; index++) {
      await advanceAck(f.dataRoot, { schemaVersion: 1, hookFingerprint: fingerprint, ackedThrough: 39, processedThrough: 40 }, 0)
    }

    expect(await absentEvidence(f.dataRoot)).toMatchObject({ absentThrough: 40, count: 40, truncated: true })
    expect((await absentEvidence(f.dataRoot))?.ranges).toHaveLength(32)
  })

  it('recovers a lost delivery outcome through an explicit notify-retry of that sequence', async () => {
    const f = await fixture()
    for (const name of ['turn-1', 'turn-2']) await completeTurn(f.root, name)
    await f.rejectSequences([1])
    await drainCommitNotifications(f.dataRoot, f.env)
    // The receipt for a still-existing record is lost: the ACK can no longer prove sequence 1.
    await rm(join(outcomesDir(f.dataRoot), pad(1)), { force: true })
    await f.rejectSequences([])
    await expect(commitNotificationStatus(f.dataRoot, f.env)).rejects.toThrow('missing delivery outcome in visited prefix')
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value)
    const stuck = await doctor(f.root)
    const delivery = stuck.report.checks.find(check => check.id === 'commitHook.delivery')
    expect(delivery).toMatchObject({ status: 'fail' })
    expect(delivery?.detail).toMatch(/sequence 1/)
    expect(delivery?.detail).toMatch(/notify-retry --sequence 1/)

    // The operator names the sequence explicitly; the record is intact and the receiver dedupes it.
    await expect(notifyRetry(f, [['sequence', '1']])).resolves.toBe(0)
    await expect(commitNotificationStatus(f.dataRoot, f.env)).resolves.toMatchObject({ ackedThrough: 2 })
    await completeTurn(f.root, 'turn-3')
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 1 })
    await expect(commitNotificationStatus(f.dataRoot, f.env)).resolves.toMatchObject({ ackedThrough: 3 })
  })

  it('doctor shows the absent sequences the ACK crossed', async () => {
    const f = await fixture()
    await completeTurn(f.root, 'turn-1')
    await f.rejectSequences([1])
    await drainCommitNotifications(f.dataRoot, f.env)
    await writeFile(join(f.dataRoot, 'sequence-watermark.json'), JSON.stringify({ schemaVersion: 1, lastIssued: 2 }))
    await completeTurn(f.root, 'turn-2')
    await drainCommitNotifications(f.dataRoot, f.env)
    await f.rejectSequences([])
    f.advance(60_000)
    await drainCommitNotifications(f.dataRoot, f.env)
    // A still-undelivered record keeps the backlog real without making the status unreadable.
    await completeTurn(f.root, 'turn-3')
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value)
    const healthy = await doctor(f.root)
    const delivery = healthy.report.checks.find(check => check.id === 'commitHook.delivery')
    expect(delivery?.detail).toMatch(/absent sequence/i)
    expect(delivery?.detail).toMatch(/2/)
    expect(healthy.report.commitNotifications).toMatchObject({ absentCount: 1, absentRanges: [[2, 2]] })

  })
}

async function doctor(root: string) {
  const chunks: string[] = []
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true })
  let code = 0
  try {
    code = await doctorCommand({ positionals: [], flags: new Map([['workspace', root]]) })
  } finally {
    output.mockRestore()
    vi.unstubAllEnvs()
  }
  return { code, report: JSON.parse(chunks.join('')) as {
    status: string
    commitNotifications?: { absentCount?: number; absentRanges?: [number, number][] }
    checks: { id: string; status: string; detail: string }[]
  } }
}
