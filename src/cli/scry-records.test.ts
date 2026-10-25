import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { listRecords, stableHash, verifyStore } from '../core/turn-recorder/store'
import { summarizeTurnRecords } from '../core/turn-recorder/turns-summary'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { runScryCli } from './scry'
import { afterEach } from 'vitest'
import { roots, workspace, captureStdout } from './scry.test-fixture.js'


const recordReads = vi.hoisted(() => new Map<string, number>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const path = args[0]
      if (typeof path === 'string' && recordReads.has(path)) recordReads.set(path, recordReads.get(path)! + 1)
      return actual.readFile(...args)
    }
  }
})

afterEach(() => recordReads.clear())


describe('scry records archive and maintenance', () => {
  async function withTurns(count: number): Promise<string> {
    const root = await workspace()
    for (let index = 1; index <= count; index++) {
      const payload = { session_id: `arch-${index}`, timestamp: '2026-07-19T12:00:00.000Z', prompt: 'p' }
      await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
      await handleRecorderHook({
        provider: 'claude',
        event: 'Stop',
        workspace: root,
        payload: { ...payload, timestamp: '2026-07-19T12:00:01.000Z' }
      })
    }
    return root
  }

  it('verify reads each canonical record once and keeps identity/open-turn evidence advisory', async () => {
    const root = await withTurns(2)
    const dataRoot = join(root, '.scry')
    const expected = summarizeTurnRecords(await listRecords(dataRoot), undefined, { scope: 'workspace' }).identity
    await writeFile(join(dataRoot, 'health.json'), JSON.stringify({ schemaVersion: 1, pendingCount: 2 }))
    for (const name of await readdir(join(dataRoot, 'records'))) recordReads.set(join(dataRoot, 'records', name), 0)
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'verify', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, records: 2, errors: [], identity: expected, openTurnsPending: 2,
      advisories: expect.arrayContaining(['open turns pending recovery: 2']) })
    expect([...recordReads.values()]).toEqual([1, 1])
  })

  it.each(['malformed JSON', 'invalid schema'])('verify retains exit 4 and unknown identity for %s without rereading', async (failure) => {
    const root = await withTurns(2)
    const recordsRoot = join(root, '.scry', 'records')
    const names = (await readdir(recordsRoot)).sort()
    const path = join(recordsRoot, names[1]!)
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, failure === 'malformed JSON' ? '{broken' : JSON.stringify({ ...original, schemaVersion: 99 }))
    for (const name of names) recordReads.set(join(recordsRoot, name), 0)
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'verify', '--workspace', root])).resolves.toBe(4)
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false, records: 2, identity: null, errors: [expect.any(String)], advisories: [] })
    expect([...recordReads.values()]).toEqual([1, 1])
  })

  it('verify retains identity for readable records even when sequence integrity fails', async () => {
    const root = await withTurns(2)
    const recordsRoot = join(root, '.scry', 'records')
    const names = (await readdir(recordsRoot)).sort()
    await rm(join(recordsRoot, names[0]!))
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'verify', '--workspace', root])).resolves.toBe(4)
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false, records: 1,
      errors: [expect.stringContaining('sequence gap')], identity: { model: { coverage: { totalTurns: 1 } } } })
  })

  it('verify preserves an empty store as valid with no identity observations', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'verify', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toEqual({ ok: true, records: 0, errors: [], archivedThrough: 0,
      identity: null, openTurnsPending: 0, advisories: [] })
  })

  it('verify does not turn an observer exception into a corrupt-record report', async () => {
    const root = await withTurns(1)
    await expect(verifyStore(join(root, '.scry'), () => { throw new Error('observer failed') })).rejects.toThrow('observer failed')
    await expect(verifyStore(join(root, '.scry'))).resolves.toMatchObject({ ok: true, records: 1, errors: [] })
  })

  it('maintenance 默认只输出计划，不执行删除', async () => {
    const root = await withTurns(1)
    const stdout = captureStdout()
    await expect(runScryCli(['records', 'maintain', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({ action: 'maintain', status: 'planned', applied: false, blockedBy: [] })

    vi.restoreAllMocks()
    const applied = captureStdout()
    await expect(runScryCli(['records', 'maintain', '--apply', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(applied.text())).toMatchObject({ action: 'maintain', status: 'applied', applied: true, blockedBy: [] })
  })

  it('归档搬移前缀并记录 floor，store 仍然 ok', async () => {
    const root = await withTurns(3)
    const out = join(root, 'archived')
    const stdout = captureStdout()
    // Records are stamped with the payload timestamp, so a future cutoff selects all of them.
    await expect(runScryCli(['records', 'archive', '--before', '2030-01-01T00:00:00.000Z', '--out', out, '--yes', '--workspace', root])).resolves.toBe(0)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    expect(result).toMatchObject({ status: 'done', archived: 3, archivedThrough: 3, remaining: 0, storeOk: true })
    expect((await readdir(join(out, 'records'))).length).toBe(3)
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as Record<string, any>
    expect(manifest.records[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('归档后新轮次接着 floor 继续，doctor 不报损坏', async () => {
    const root = await withTurns(2)
    await runScryCli(['records', 'archive', '--before', '2030-01-01T00:00:00.000Z', '--yes', '--workspace', root])
    const payload = { session_id: 'arch-next', timestamp: '2026-07-19T13:00:00.000Z', prompt: 'p' }
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: { ...payload, timestamp: '2026-07-19T13:00:01.000Z' } })

    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report.status).toBe('healthy')
    expect(report.store).toMatchObject({ ok: true, records: 1, archivedThrough: 2 })
  })

  it('不带 --yes 只打印计划；无候选时退出 3', async () => {
    const root = await withTurns(1)
    const plan = captureStdout()
    await expect(runScryCli(['records', 'archive', '--before', '2030-01-01T00:00:00.000Z', '--workspace', root])).resolves.toBe(3)
    expect((JSON.parse(plan.text()) as Record<string, any>).status).toBe('approval-required')
    expect((await readdir(join(root, '.scry', 'records'))).length).toBe(1)

    vi.restoreAllMocks()
    const empty = captureStdout()
    await expect(runScryCli(['records', 'archive', '--before', '2000-01-01T00:00:00.000Z', '--workspace', root])).resolves.toBe(3)
    expect((JSON.parse(empty.text()) as Record<string, any>).status).toBe('nothing-to-archive')
  })

  it('配置了 commit hook 但尚未投递时拒绝归档', async () => {
    const root = await withTurns(2)
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, any>
    config.commitHook = { entry: 'uploader.sh', files: ['uploader.sh'] }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    const notifications = join(root, '.scry', 'notifications')
    await mkdir(join(notifications, 'commit-hooks'), { recursive: true })
    const other = JSON.stringify({ schemaVersion: 1, hookFingerprint: 'other-app', ackedThrough: 2 })
    await writeFile(join(notifications, 'commit-hook-state.json'), other)
    await writeFile(join(notifications, 'commit-hooks', `${stableHash('other-app')}.json`), other)
    process.env.SCRY_GRANT_DIR = join(root, 'grants')
    try {
      const stdout = captureStdout()
      await expect(runScryCli(['records', 'archive', '--before', '2030-01-01T00:00:00.000Z', '--yes', '--workspace', root])).resolves.toBe(5)
      const result = JSON.parse(stdout.text()) as Record<string, any>
      expect(result).toMatchObject({ status: 'refused', reason: 'undelivered-records' })
      expect(result.remediation).toContain('notify-drain')
      expect((await readdir(join(root, '.scry', 'records'))).length).toBe(2)
    } finally {
      delete process.env.SCRY_GRANT_DIR
    }
  })
})

describe('scry support-bundle', () => {
  it('只输出脱敏诊断，不含 record 正文、路径与 env 值', async () => {
    const root = await workspace()
    const SECRET = 'BUNDLE-MUST-NOT-CONTAIN-THIS'
    const payload = { session_id: 'bundle-1', timestamp: '2026-07-19T12:00:00.000Z', prompt: SECRET }
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: { ...payload, timestamp: '2026-07-19T12:00:01.000Z' } })

    const stdout = captureStdout()
    await expect(runScryCli(['support-bundle', 'create', '--workspace', root])).resolves.toBe(0)
    const text = stdout.text()
    const bundle = JSON.parse(text) as Record<string, any>

    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(root)
    expect(bundle.workspace.idHash).toMatch(/^sha256:[a-f0-9]{32}$/)
    expect(bundle.workspace.configFingerprint).toMatch(/^sha256:[a-f0-9]{32}$/)
    expect(bundle.workspace.capture).toMatchObject({ prompt: true, assistant: true, toolOutput: 'summary' })
    expect(bundle.recorder).toMatchObject({ enabled: true })
    expect(bundle.recorder.store).toMatchObject({ ok: true, records: 1 })
    expect(bundle.omitted.length).toBeGreaterThan(0)
  })

  it('写入文件时权限 0600，且 recorder 未启用退出 2', async () => {
    const root = await workspace()
    const out = join(root, 'bundle.json')
    await expect(runScryCli(['support-bundle', 'create', '--out', out, '--workspace', root])).resolves.toBe(0)
    expect((await stat(out)).mode & 0o777).toBe(0o600)

    const bare = await mkdtemp(join(tmpdir(), 'scry-cli-bundle-'))
    roots.push(bare)
    const stdout = captureStdout()
    await expect(runScryCli(['support-bundle', 'create', '--workspace', bare])).resolves.toBe(2)
    expect((JSON.parse(stdout.text()) as Record<string, any>).recorder).toMatchObject({ enabled: false, reason: 'missing_config' })
  })
})
