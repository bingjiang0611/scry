import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { doctorCommand } from '../../../cli/doctor-command.js'
import { commitNotificationStatus, drainCommitNotifications, listRecords } from '../store'
import { commitAckPath, commitHook, completeTurn, workspace } from './fixture.test'

/**
 * Sequence numbers are the uploader's dedupe key. Reissuing one after the operator deletes a
 * record file (without `scry turns archive`) makes the drain skip the new record: delivery only
 * walks sequences above `processedThrough`, so the reused number is silently never notified.
 */
export function registerSuite21(): void {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const fingerprint = 'sequence-reuse-fixture-v1'
  const deliveryEnv = (hook: { path: string }) => ({
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SCRY_RECORDER_COMMIT_HOOK: hook.path,
    SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: fingerprint
  })

  async function ackedFixture(turns: number) {
    const root = await workspace()
    for (let index = 1; index <= turns; index++) await completeTurn(root, `turn-${index}`)
    const dataRoot = join(root, '.scry')
    const hook = await commitHook(root)
    const env = deliveryEnv(hook)
    await drainCommitNotifications(dataRoot, env)
    await expect(commitNotificationStatus(dataRoot, env)).resolves.toMatchObject({ ackedThrough: turns })
    return { root, dataRoot, hook, env }
  }

  async function recordNameOf(dataRoot: string, sequence: number): Promise<string> {
    const prefix = String(sequence).padStart(20, '0')
    const name = (await readdir(join(dataRoot, 'records'))).find(entry => entry.startsWith(prefix))
    if (!name) throw new Error(`record ${sequence} not found`)
    return name
  }

  async function deliveredSequences(capture: string): Promise<number[]> {
    return (await readFile(capture, 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { sequence: number }).sequence)
  }

  it('allocates above an acknowledged sequence whose record file was deleted, and still delivers it', async () => {
    const f = await ackedFixture(3)
    await rm(join(f.dataRoot, 'records', await recordNameOf(f.dataRoot, 3)), { force: true })

    await completeTurn(f.root, 'turn-4')

    // Reusing 3 would keep the drain at `processedThrough = 3`, so turn-4 would never be notified.
    expect((await listRecords(f.dataRoot)).map(record => record.sequence)).toEqual([1, 2, 4])
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 1, pending: 0 })
    await expect(deliveredSequences(f.hook.capture)).resolves.toEqual([1, 2, 3, 4])
    await expect(commitNotificationStatus(f.dataRoot, f.env)).resolves.toEqual({ ackedThrough: 4, notifyBacklog: 0 })
  })

  it('keeps allocating above the acknowledged floor when every record file is gone', async () => {
    const f = await ackedFixture(3)
    await rm(join(f.dataRoot, 'records'), { recursive: true, force: true })

    await completeTurn(f.root, 'turn-4')

    expect((await listRecords(f.dataRoot)).map(record => record.sequence)).toEqual([4])
    await expect(drainCommitNotifications(f.dataRoot, f.env)).resolves.toMatchObject({ delivered: 1, pending: 0 })
    await expect(deliveredSequences(f.hook.capture)).resolves.toEqual([1, 2, 3, 4])
  })

  it('initializes the issued floor from an existing delivery checkpoint (workspace written before the watermark)', async () => {
    const root = await workspace()
    for (let index = 1; index <= 3; index++) await completeTurn(root, `legacy-${index}`)
    const dataRoot = join(root, '.scry')
    const hook = await commitHook(root)
    const env = deliveryEnv(hook)
    await mkdir(join(dataRoot, 'notifications', 'commit-hooks'), { recursive: true })
    await writeFile(commitAckPath(root, fingerprint), JSON.stringify({ schemaVersion: 1, hookFingerprint: fingerprint, ackedThrough: 3 }))
    // An older CLI wrote no watermark, and the operator then removed the live records.
    await rm(join(dataRoot, 'sequence-watermark.json'), { force: true })
    await rm(join(dataRoot, 'records'), { recursive: true, force: true })

    await completeTurn(root, 'legacy-4')

    expect((await listRecords(dataRoot)).map(record => record.sequence)).toEqual([4])
    await expect(drainCommitNotifications(dataRoot, env)).resolves.toMatchObject({ delivered: 1, pending: 0 })
    await expect(deliveredSequences(hook.capture)).resolves.toEqual([4])
  })

  it('doctor warns when only the issued watermark is ahead, e.g. after a commit interrupted before the record write', async () => {
    const root = await workspace()
    await completeTurn(root, 'turn-1')
    const dataRoot = join(root, '.scry')
    await writeFile(join(dataRoot, 'sequence-watermark.json'), JSON.stringify({ schemaVersion: 1, lastIssued: 2 }))
    const chunks: string[] = []
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true })
    try {
      await expect(doctorCommand({ positionals: [], flags: new Map([['workspace', root]]) })).resolves.toBe(5)
    } finally {
      output.mockRestore()
    }
    const report = JSON.parse(chunks.join('')) as { status: string; checks: { id: string; status: string; detail: string }[] }
    const check = report.checks.find(item => item.id === 'records.sequence')
    expect(check).toMatchObject({ status: 'warn' })
    expect(check?.detail).toContain('interrupted')
    expect(report.status).toBe('degraded')
  })

  it('doctor warns about records deleted outside archive instead of reporting healthy', async () => {
    const f = await ackedFixture(3)
    await rm(join(f.dataRoot, 'records', await recordNameOf(f.dataRoot, 3)), { force: true })
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value)
    const chunks: string[] = []
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true })
    let code = 0
    try {
      code = await doctorCommand({ positionals: [], flags: new Map([['workspace', f.root]]) })
    } finally {
      output.mockRestore()
    }
    const report = JSON.parse(chunks.join('')) as {
      status: string
      checks: { id: string; status: string; detail: string; remediation?: string }[]
    }
    const check = report.checks.find(item => item.id === 'records.sequence')
    expect(check).toMatchObject({ status: 'warn' })
    expect(check?.detail).toMatch(/deleted outside/)
    expect(check?.remediation).toMatch(/archive/)
    expect(report.status).toBe('degraded')
    expect(code).toBe(5)
  })
}
